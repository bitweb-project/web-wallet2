const { Buffer } = require('buffer')
globalThis.Buffer = Buffer

const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
// 2.x: import requires .js suffix
const { secp256k1, schnorr } = require('@noble/curves/secp256k1.js')

// Direct adapter over @noble/curves/secp256k1 (Paul Miller, Cure53 audited).
// Targets @noble/curves 2.x API:
//   - sign() returns Uint8Array directly (no .toCompactRawBytes() needed)
//   - ProjectivePoint → Point
//   - .toRawBytes() → .toBytes()
//   - Signature.fromCompact() → Signature.fromBytes()
//   - CRITICAL: prehash: false required — 2.x default changed to prehash: true
//   - verify() accepts Uint8Array directly (not Signature object)
//   - Point.fromBytes() instead of Point.fromHex() — no hex string for point data
const ecc = (function() {
  const G = secp256k1.Point.BASE

  // secp256k1 group order — well-known constant, not exposed in 2.x public API
  const ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n

  // Buffer → BigInt without intermediate hex string.
  // Private key material avoids hex strings because n.toString(16) produces
  // an immutable JS string containing key bytes that cannot be zeroed.
  // BigInt values are themselves immutable — a fundamental JS language limit
  // shared by all pure-JS crypto libs including @noble/curves itself.
  function bufToBigInt(buf) {
    let n = 0n
    for (let i = 0; i < buf.length; i++) {
      n = (n << 8n) | BigInt(buf[i])
    }
    return n
  }

  // BigInt → 32-byte Buffer without intermediate hex string
  function bigIntToBuffer32(n) {
    const buf = Buffer.allocUnsafe(32)
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(n & 0xffn)
      n >>= 8n
    }
    return buf
  }

  // 2.x: Point.fromBytes() instead of Point.fromHex() — no hex string for point data
  function isPoint(p) {
    if (!p || (p.length !== 33 && p.length !== 65)) return false
    try { secp256k1.Point.fromBytes(p); return true }
    catch(e) { return false }
  }

  function isXOnlyPoint(p) {
    if (!p || p.length !== 32) return false
    const prefixed = new Uint8Array(33)
    prefixed[0] = 0x02
    prefixed.set(p, 1)
    try { secp256k1.Point.fromBytes(prefixed); return true }
    catch(e) { return false }
  }

  // Private key check — secp256k1.utils.isValidSecretKey covers 0 < d < ORDER
  function isPrivate(d) {
    if (!d || d.length !== 32) return false
    return secp256k1.utils.isValidSecretKey(d)
  }

  // 2.x: .toBytes() instead of .toRawBytes()
  function pointCompress(p, compressed) {
    const pt = secp256k1.Point.fromBytes(p)
    return pt.toBytes(compressed !== false)
  }

  // Private key input — bufToBigInt avoids hex string of key material
  function pointFromScalar(d, compressed) {
    if (!isPrivate(d)) return null
    const pt = G.multiply(bufToBigInt(d))
    return pt.toBytes(compressed !== false)
  }

  function xOnlyPointAddTweak(p, tweak) {
    try {
      const prefixed = new Uint8Array(33)
      prefixed[0] = 0x02
      prefixed.set(p, 1)
      const px = secp256k1.Point.fromBytes(prefixed)
      const t = bufToBigInt(tweak)
      if (t >= ORDER) return null
      const result = px.add(G.multiply(t))
      if (result.equals(secp256k1.Point.ZERO)) return null
      const raw = result.toBytes(true)
      return { parity: raw[0] === 3 ? 1 : 0, xOnlyPubkey: raw.slice(1) }
    } catch(e) { return null }
  }

  // Both inputs are key material — no hex strings
  function privateAdd(d, tweak) {
    const dn = bufToBigInt(d)
    const tn = bufToBigInt(tweak)
    const result = (dn + tn) % ORDER
    if (result === 0n) return null
    return bigIntToBuffer32(result)
  }

  // Input is key material — no hex strings
  function privateNegate(d) {
    const dn = bufToBigInt(d)
    const result = (ORDER - dn) % ORDER
    return bigIntToBuffer32(result)
  }

  // 2.x: sign() returns Uint8Array directly — no .toCompactRawBytes() needed.
  // CRITICAL: prehash: false required — 2.x default changed to prehash: true.
  // Bitcoin passes a pre-hashed 32-byte digest; prehash: true would double-hash.
  function sign(hash, priv, extra) {
    return secp256k1.sign(hash, priv, {
      lowS:         true,
      prehash:      false,
      extraEntropy: extra || undefined
    })
  }

  // 2.x: verify() accepts Uint8Array directly (NOT Signature object — throws if passed).
  // Signature.fromBytes() used only for the optional strict=true hasHighS check.
  // CRITICAL: prehash: false required here too.
  function verify(hash, pub, sig, strict) {
    try {
      if (strict) {
        const s = secp256k1.Signature.fromBytes(sig)
        if (s.hasHighS()) return false
      }
      return secp256k1.verify(sig, hash, pub, { prehash: false })
    } catch(e) { return false }
  }

  function signSchnorr(hash, priv, extra) {
    return schnorr.sign(hash, priv, extra)
  }

  function verifySchnorr(hash, pub, sig) {
    try { return schnorr.verify(sig, hash, pub) }
    catch(e) { return false }
  }

  return {
    isPoint, isXOnlyPoint, isPrivate,
    pointCompress, pointFromScalar, xOnlyPointAddTweak,
    privateAdd, privateNegate,
    sign, verify, signSchnorr, verifySchnorr
  }
})()

bitcoin.initEccLib(ecc)
bitcoin.ECPair = ECPairFactory(ecc)
bitcoin.Buffer = Buffer
bitcoin.ecc    = ecc

// ============================================================
// BIP341 key-path taproot signer — lives in the bundle so that
// all crypto primitives (tweak computation + key zeroing) are
// co-located with the ecc adapter and auditable in one place.
//
// Usage (wallet.js):
//   bitcoin.taproot.makeKeySigner(kp, function(signer) {
//     psbt.signInput(idx, signer)
//   })
//
// The callback receives a signer object valid only for the
// duration of the callback. All derived key material (rawD,
// effectiveD, tweakedD) is zeroed in the finally block — even
// on exception — before control returns to the caller.
// ============================================================
bitcoin.taproot = (function() {
  function makeKeySigner(kp, onSigned) {
    if (!kp.privateKey) {
      throw new Error('taproot.makeKeySigner: private key required')
    }
    // 32-byte x-only of internal public key P
    const xOnlyPub = kp.publicKey.slice(1)
    // BIP341: hash_TapTweak(bytes(P))  — taggedHash lives in bitcoin.crypto
    const tweak    = bitcoin.crypto.taggedHash('TapTweak', xOnlyPub)
    // Copy of raw private key — zeroed in finally regardless of outcome
    const rawD     = new Uint8Array(kp.privateKey)
    let effectiveD = null
    let tweakedD   = null
    try {
      // BIP340 requires even y on the internal key before adding tweak.
      // If y is odd (prefix 0x03), negate the private key first.
      const oddY = (kp.publicKey[0] === 0x03)
      effectiveD = oddY ? ecc.privateNegate(rawD) : new Uint8Array(rawD)
      tweakedD   = ecc.privateAdd(effectiveD, tweak)
      if (!tweakedD) throw new Error('TapTweak produced an invalid private key')
      const tweakedPubResult = ecc.xOnlyPointAddTweak(xOnlyPub, tweak)
      if (!tweakedPubResult) throw new Error('xOnlyPointAddTweak failed')
      // Capture tweakedD before finally can null it — signer is valid only
      // inside the callback; caller must not store signSchnorr for later use.
      const td = tweakedD
      onSigned({
        publicKey:   tweakedPubResult.xOnlyPubkey,
        signSchnorr: function(hash) { return ecc.signSchnorr(hash, td) }
      })
    } finally {
      rawD.fill(0)
      if (effectiveD) effectiveD.fill(0)
      if (tweakedD)   tweakedD.fill(0)
    }
  }

  return { makeKeySigner: makeKeySigner }
})()

module.exports = bitcoin
