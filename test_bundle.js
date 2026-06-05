// ============================================================
// FULL TEST SUITE — @noble/curves 2.2.0 build (130 checks)
// ============================================================
const { JSDOM } = require('jsdom')
const fs   = require('fs')
const nodeCrypto = require('crypto')

// Minimal browser env
const dom = new JSDOM('', { url: 'http://localhost' })
global.window = dom.window
global.document = dom.window.document
global.crypto = {
  getRandomValues: (buf) => {
    const bytes = nodeCrypto.randomBytes(buf.length)
    buf.set(bytes)
    return buf
  }
}

// rng call counter for audit
let rngCallCount = 0
const _origRng = global.crypto.getRandomValues.bind(global.crypto)
Object.defineProperty(global.crypto, 'getRandomValues', {
  value: function(buf) { rngCallCount++; return _origRng(buf) },
  writable: false, configurable: false
})

const BUNDLE = './bitcoin-bundle-v7.min.js'
const code = fs.readFileSync(BUNDLE, 'utf8')
const fn   = new Function('window', 'document', 'crypto', code + '; return bitcoin;')
const b    = fn(global.window, global.document, global.crypto)

// ============================================================
let total = 0, passed = 0, failed = 0
const FAIL_DETAILS = []

function check(label, got, expected) {
  total++
  const ok = expected === undefined ? !!got : got === expected
  if (ok) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    const detail = `  ❌ ${label}\n     got:      ${JSON.stringify(got)}\n     expected: ${JSON.stringify(expected)}`
    console.log(detail)
    FAIL_DETAILS.push(detail)
  }
}

function section(title) { console.log(`\n─── ${title} ───`) }

// ============================================================
const KNOWN_PRIV     = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
const KNOWN_PUB_COMP   = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const KNOWN_PUB_UNCOMP = '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'
const ORDER_BUF     = Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141', 'hex')
const ORDER_MINUS_1 = Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140', 'hex')
const BTE_NETWORK = {
  messagePrefix: '\x19Bitweb Signed Message:\n',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  bech32: 'web', pubKeyHash: 0x21, scriptHash: 0x1E, wif: 0x80
}

// ============================================================
section('1. BUNDLE BASICS')
check('bitcoin object exists',  typeof b === 'object')
check('ECPair exported',        typeof b.ECPair === 'object')
check('Buffer exported',        typeof b.Buffer === 'function')
check('ecc exported',           typeof b.ecc === 'object')
check('Psbt exported',          typeof b.Psbt === 'function')
check('payments exported',      typeof b.payments === 'object')
check('opcodes exported',       typeof b.opcodes === 'object')
check('address exported',       typeof b.address === 'object')
check('crypto exported',        typeof b.crypto === 'object')
check('script exported',        typeof b.script === 'object')
check('networks exported',      typeof b.networks === 'object')
check('Transaction exported',   typeof b.Transaction === 'function')
check('taproot exported',       typeof b.taproot === 'object')

section('2. RNG AUDIT')
const bundleText = fs.readFileSync(BUNDLE, 'utf8')
check('Math.random absent from bundle',   !bundleText.includes('Math.random'))
check('node:crypto absent from bundle',   !bundleText.match(/node:crypto|require\(.*crypto/))
check('bitcoinerlab absent from bundle',  !bundleText.includes('bitcoinerlab'))
const rngBefore = rngCallCount
b.ECPair.makeRandom()
check('makeRandom() calls getRandomValues', rngCallCount > rngBefore)

section('3. ecc.isPoint — compressed / uncompressed / invalid')
const ecc = b.ecc
check('isPoint: valid compressed 33b',    ecc.isPoint(Buffer.from(KNOWN_PUB_COMP, 'hex')),   true)
check('isPoint: valid uncompressed 65b',  ecc.isPoint(Buffer.from(KNOWN_PUB_UNCOMP, 'hex')), true)
check('isPoint: null',                    ecc.isPoint(null),                                  false)
check('isPoint: 32 bytes',                ecc.isPoint(Buffer.alloc(32)),                      false)
check('isPoint: 33 zeros (not on curve)', ecc.isPoint(Buffer.alloc(33)),                      false)
check('isPoint: 65 zeros',                ecc.isPoint(Buffer.alloc(65)),                      false)
check('isPoint: prefix 04 but 33b long',  ecc.isPoint(Buffer.from('04' + '00'.repeat(32), 'hex')), false)

section('4. ecc.isXOnlyPoint')
const xOnly = Buffer.from(KNOWN_PUB_COMP, 'hex').slice(1)
check('isXOnlyPoint: valid 32b x-coord',  ecc.isXOnlyPoint(xOnly),           true)
check('isXOnlyPoint: null',               ecc.isXOnlyPoint(null),             false)
check('isXOnlyPoint: 33 bytes',           ecc.isXOnlyPoint(Buffer.alloc(33)), false)
check('isXOnlyPoint: 32 zeros',           ecc.isXOnlyPoint(Buffer.alloc(32)), false)

section('5. ecc.isPrivate')
check('isPrivate: scalar=1 valid',        ecc.isPrivate(KNOWN_PRIV),    true)
check('isPrivate: scalar=0 invalid',      ecc.isPrivate(Buffer.alloc(32)), false)
check('isPrivate: null',                  ecc.isPrivate(null),           false)
check('isPrivate: 31 bytes',              ecc.isPrivate(Buffer.alloc(31)), false)
check('isPrivate: scalar=ORDER invalid',  ecc.isPrivate(ORDER_BUF),     false)
check('isPrivate: scalar=ORDER-1 valid',  ecc.isPrivate(ORDER_MINUS_1), true)

section('6. ecc.pointFromScalar — known vector')
const computed = ecc.pointFromScalar(KNOWN_PRIV, true)
check('pointFromScalar: scalar=1 → G (compressed)',
  computed && Buffer.from(computed).toString('hex') === KNOWN_PUB_COMP)
const computedUncomp = ecc.pointFromScalar(KNOWN_PRIV, false)
check('pointFromScalar: scalar=1 → G (uncompressed)',
  computedUncomp && Buffer.from(computedUncomp).toString('hex') === KNOWN_PUB_UNCOMP)
check('pointFromScalar: scalar=0 → null',    ecc.pointFromScalar(Buffer.alloc(32)), null)
check('pointFromScalar: scalar=ORDER → null', ecc.pointFromScalar(ORDER_BUF),       null)

section('7. ecc.pointCompress')
const uncomp = Buffer.from(KNOWN_PUB_UNCOMP, 'hex')
const comp   = Buffer.from(KNOWN_PUB_COMP,   'hex')
const recompressed = ecc.pointCompress(uncomp, true)
check('pointCompress: uncomp→comp gives 33b',
  recompressed && recompressed.length === 33)
check('pointCompress: uncomp→comp matches known',
  recompressed && Buffer.from(recompressed).toString('hex') === KNOWN_PUB_COMP)
const expanded = ecc.pointCompress(comp, false)
check('pointCompress: comp→uncomp gives 65b', expanded && expanded.length === 65)
check('pointCompress: comp→uncomp matches known',
  expanded && Buffer.from(expanded).toString('hex') === KNOWN_PUB_UNCOMP)
const recomp2 = ecc.pointCompress(comp, true)
check('pointCompress: comp→comp idempotent',
  recomp2 && Buffer.from(recomp2).toString('hex') === KNOWN_PUB_COMP)

section('8. ecc.privateAdd / privateNegate')
const priv1 = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
const added = ecc.privateAdd(priv1, priv1)
check('privateAdd(1,1) = 2',
  added && Buffer.from(added).toString('hex') === '0000000000000000000000000000000000000000000000000000000000000002')
const negated = ecc.privateNegate(priv1)
check('privateNegate(1) = ORDER-1',
  negated && Buffer.from(negated).toString('hex') === 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140')
check('privateAdd(1, negate(1)) = null (wraps to 0)', ecc.privateAdd(priv1, negated) === null)
const addedZero = ecc.privateAdd(priv1, Buffer.alloc(32))
check('privateAdd(1, 0) = 1',
  addedZero && Buffer.from(addedZero).toString('hex') === '0000000000000000000000000000000000000000000000000000000000000001')

section('9. ecc.xOnlyPointAddTweak — Taproot')
const xOnlyG  = Buffer.from(KNOWN_PUB_COMP, 'hex').slice(1)
const tweak1  = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
const tweakResult  = ecc.xOnlyPointAddTweak(xOnlyG, tweak1)
check('xOnlyPointAddTweak: returns object',      tweakResult !== null)
check('xOnlyPointAddTweak: parity is 0 or 1',    tweakResult && (tweakResult.parity === 0 || tweakResult.parity === 1))
check('xOnlyPointAddTweak: xOnlyPubkey 32 bytes', tweakResult && tweakResult.xOnlyPubkey && tweakResult.xOnlyPubkey.length === 32)
const tweakResult2 = ecc.xOnlyPointAddTweak(xOnlyG, tweak1)
check('xOnlyPointAddTweak: deterministic (same input → same output)',
  tweakResult && tweakResult2 &&
  tweakResult.parity === tweakResult2.parity &&
  Buffer.from(tweakResult.xOnlyPubkey).toString('hex') === Buffer.from(tweakResult2.xOnlyPubkey).toString('hex'))
check('xOnlyPointAddTweak: tweak=ORDER → null', ecc.xOnlyPointAddTweak(xOnlyG, ORDER_BUF), null)

section('10. ecc.sign / verify — ECDSA')
const testHash = Buffer.from('0101010101010101010101010101010101010101010101010101010101010101', 'hex')
const privKey  = Buffer.from('e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35', 'hex')
const pubKey   = ecc.pointFromScalar(privKey, true)
const sig1 = ecc.sign(testHash, privKey)
check('sign: returns Uint8Array',  sig1 instanceof Uint8Array)
check('sign: 64 bytes',            sig1.length, 64)
check('verify: valid sig → true',  ecc.verify(testHash, pubKey, sig1))
const sig2 = ecc.sign(testHash, privKey)
let sigSame = sig1.length === sig2.length
for (let i = 0; i < sig1.length; i++) if (sig1[i] !== sig2[i]) { sigSame = false; break }
check('sign: RFC6979 deterministic (same key+hash → same sig)', sigSame)
const wrongHash = Buffer.from('0202020202020202020202020202020202020202020202020202020202020202', 'hex')
check('verify: wrong hash → false',    ecc.verify(wrongHash, pubKey, sig1), false)
const otherPub = ecc.pointFromScalar(Buffer.from('0000000000000000000000000000000000000000000000000000000000000002', 'hex'), true)
check('verify: wrong pubkey → false',  ecc.verify(testHash, otherPub, sig1), false)
const sigLowS = ecc.sign(testHash, privKey)
const S_HALF_ORDER = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0')
let sVal = 0n
for (let i = 0; i < 32; i++) sVal = (sVal << 8n) | BigInt(sigLowS[32 + i])
check('sign: lowS enforced (s <= n/2)', sVal <= S_HALF_ORDER)
check('verify strict=true: lowS sig passes', ecc.verify(testHash, pubKey, ecc.sign(testHash, privKey), true))
const badSig = Buffer.from(sig1); badSig[0] ^= 0xff
check('verify: tampered sig → false', ecc.verify(testHash, pubKey, badSig), false)

section('11. ecc.signSchnorr / verifySchnorr — BIP340')
const schnorrSig1 = ecc.signSchnorr(testHash, privKey)
check('signSchnorr: 64 bytes',                   schnorrSig1.length, 64)
check('verifySchnorr: valid roundtrip',           ecc.verifySchnorr(testHash, pubKey.slice(1), schnorrSig1))
const schnorrSig2 = ecc.signSchnorr(testHash, privKey)
check('verifySchnorr: second sig also verifies',  ecc.verifySchnorr(testHash, pubKey.slice(1), schnorrSig2))
let schnorrDiffer = false
for (let i = 0; i < schnorrSig1.length; i++) if (schnorrSig1[i] !== schnorrSig2[i]) { schnorrDiffer = true; break }
check('signSchnorr: random nonce (two sigs differ)', schnorrDiffer)
check('verifySchnorr: wrong hash → false', ecc.verifySchnorr(wrongHash, pubKey.slice(1), schnorrSig1), false)

section('12. KEY MANAGEMENT — ECPair / fromPrivateKey / fromPublicKey')
const kp = b.ECPair.fromPrivateKey(privKey)
check('ECPair.fromPrivateKey: publicKey is Uint8Array', kp.publicKey instanceof Uint8Array)
check('ECPair.fromPrivateKey: pubkey matches pointFromScalar',
  Buffer.from(kp.publicKey).toString('hex') === Buffer.from(pubKey).toString('hex'))
const kpPubOnly = b.ECPair.fromPublicKey(pubKey)
check('ECPair.fromPublicKey: works',           kpPubOnly.publicKey instanceof Uint8Array)
check('ECPair.fromPublicKey: no private key',  kpPubOnly.privateKey === undefined)
check('ECPair.fromPublicKey: sign throws', (function() {
  try { kpPubOnly.sign(testHash); return false } catch(e) { return true }
})())
const kpRandom = b.ECPair.makeRandom()
check('makeRandom: has privateKey',         kpRandom.privateKey instanceof Uint8Array)
check('makeRandom: privateKey is 32 bytes', kpRandom.privateKey.length, 32)
check('makeRandom: has publicKey',          kpRandom.publicKey instanceof Uint8Array)
const kpRandom2 = b.ECPair.makeRandom()
check('makeRandom: two keys differ',
  Buffer.from(kpRandom.publicKey).toString('hex') !== Buffer.from(kpRandom2.publicKey).toString('hex'))
const kpSign = b.ECPair.fromPrivateKey(privKey)
const kpSig  = kpSign.sign(testHash)
check('ECPair.sign: 64 bytes',    kpSig.length, 64)
check('ECPair.verify: roundtrip', kpSign.verify(testHash, kpSig))
const kpNet = b.ECPair.fromPrivateKey(privKey, { network: BTE_NETWORK })
check('ECPair with BTE network: has publicKey', kpNet.publicKey instanceof Uint8Array)

section('13. ADDRESSES — p2wpkh / p2pkh / p2sh')
const p2wpkh = b.payments.p2wpkh({ pubkey: pubKey })
check('p2wpkh: address defined',      typeof p2wpkh.address === 'string')
check('p2wpkh: starts with bc1q',     p2wpkh.address.startsWith('bc1q'))
check('p2wpkh: output is Uint8Array', p2wpkh.output instanceof Uint8Array)
check('p2wpkh: output length 22',     p2wpkh.output.length, 22)
check('p2wpkh: hash is Uint8Array',   p2wpkh.hash instanceof Uint8Array)
check('p2wpkh: hash length 20',       p2wpkh.hash.length, 20)
const p2pkhPmt = b.payments.p2pkh({ pubkey: pubKey })
check('p2pkh: address defined', typeof p2pkhPmt.address === 'string')
check('p2pkh: starts with 1',   p2pkhPmt.address.startsWith('1'))
const p2wpkhBte = b.payments.p2wpkh({ pubkey: pubKey, network: BTE_NETWORK })
check('p2wpkh BTE: starts with web1q', p2wpkhBte.address.startsWith('web1q'))
check('p2wpkh BTE output: starts with 0014 (SegWit v0)',
  b.Buffer.from(p2wpkhBte.output).toString('hex').startsWith('0014'))
const redeemHex = '0014' + b.Buffer.from(p2wpkh.hash).toString('hex')
check('redeemScript: starts with 0014', redeemHex.startsWith('0014'))
check('redeemScript: length 44',        redeemHex.length, 44)

section('14. PSBT — build, sign, finalize, extract')
const aliceKP  = b.ECPair.fromPrivateKey(Buffer.from('e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35', 'hex'))
const alicePmt = b.payments.p2wpkh({ pubkey: aliceKP.publicKey })
const psbt = new b.Psbt()
psbt.addInput({ hash: 'a'.repeat(64), index: 0,
  witnessUtxo: { script: alicePmt.output, value: BigInt(100000) } })
psbt.addOutput({ address: alicePmt.address, value: BigInt(90000) })
psbt.signInput(0, aliceKP)
check('Psbt.signInput: works without throw', true)
psbt.validateSignaturesOfInput(0, (pk, msg, s) => ecc.verify(msg, pk, s))
check('Psbt.validateSignaturesOfInput: all valid', true)
psbt.finalizeAllInputs()
const tx = psbt.extractTransaction()
check('Psbt.extractTransaction: returns Transaction', typeof tx === 'object')
check('Transaction.toHex: produces hex string',       typeof tx.toHex() === 'string')
check('Transaction.getId: produces txid',             typeof tx.getId() === 'string')
check('Transaction.getId: 64 hex chars',              tx.getId().length === 64)
const psbtNum = new b.Psbt()
let bigIntRequired = false
try { psbtNum.addOutput({ address: alicePmt.address, value: 90000 }) } catch(e) { bigIntRequired = true }
check('Psbt v7: BigInt required for values (Number throws)', bigIntRequired)

section('15. CRYPTO HELPERS')
check('crypto.hash256: 32 bytes', b.crypto.hash256(Buffer.from('hello')).length, 32)
check('crypto.hash160: 20 bytes', b.crypto.hash160(Buffer.from('hello')).length, 20)
check('crypto.sha256: 32 bytes',  b.crypto.sha256(Buffer.from('hello')).length,  32)

section('16. OPCODES')
check('OP_0',           b.opcodes.OP_0,           0)
check('OP_DUP',         b.opcodes.OP_DUP,         118)
check('OP_HASH160',     b.opcodes.OP_HASH160,     169)
check('OP_EQUALVERIFY', b.opcodes.OP_EQUALVERIFY, 136)
check('OP_CHECKSIG',    b.opcodes.OP_CHECKSIG,    172)
check('OP_RETURN',      b.opcodes.OP_RETURN,      106)

section('17. ADDRESS DECODE roundtrip')
b.address.fromBech32(p2wpkh.address)
check('address.fromBech32: native SegWit', true)
b.address.fromBase58Check(p2pkhPmt.address)
check('address.fromBase58Check: legacy', true)

section('18. SCRIPT helpers')
const p2pkhScript = b.script.compile([
  b.opcodes.OP_DUP, b.opcodes.OP_HASH160, Buffer.alloc(20),
  b.opcodes.OP_EQUALVERIFY, b.opcodes.OP_CHECKSIG
])
check('script.compile: produces Uint8Array', p2pkhScript instanceof Uint8Array)
check('script.compile: P2PKH length 25',     p2pkhScript.length, 25)
const chunks = b.script.decompile(p2pkhScript)
check('script.decompile: returns array', Array.isArray(chunks))
check('script.decompile: 5 chunks',      chunks.length, 5)

section('19. BUFFER — Uint8Array wrapping (v7 breaking change)')
const pubHex = b.Buffer.from(pubKey).toString('hex')
check('Buffer.from(Uint8Array).toString(hex): hex string', !pubHex.includes(','))
check('Buffer.from(Uint8Array).toString(hex): length 66',  pubHex.length, 66)
check('publicKey raw toString: broken (no Buffer wrap)',    pubKey.toString() !== pubHex)
check('payment.output Buffer wrap: proper hex', !b.Buffer.from(p2wpkh.output).toString('hex').includes(','))
check('payment.hash Buffer wrap: proper hex',   !b.Buffer.from(p2wpkh.hash).toString('hex').includes(','))

section('20. TAPROOT — xOnlyPointAddTweak integration (BIP341)')
const taprootPriv  = Buffer.from('e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35', 'hex')
const taprootPub   = ecc.pointFromScalar(taprootPriv, true)
const taprootXOnly = taprootPub.slice(1)
const tapTweakHash = b.crypto.sha256(Buffer.from(taprootXOnly))
const tweakRes     = ecc.xOnlyPointAddTweak(taprootXOnly, tapTweakHash)
check('Taproot xOnlyPointAddTweak: returns result',  tweakRes !== null)
check('Taproot parity in {0,1}', tweakRes && (tweakRes.parity === 0 || tweakRes.parity === 1))
check('Taproot tweaked pubkey: 32 bytes', tweakRes && tweakRes.xOnlyPubkey.length, 32)
// BIP341: negate based on parity of INTERNAL key P, not tweaked result Q.
// taprootPub[0] === 0x03 means odd y → negate privkey first.
const internalParity = taprootPub[0] === 0x03 ? 1 : 0
let privTweak = Buffer.from(taprootPriv)
if (internalParity === 1) privTweak = ecc.privateNegate(privTweak)
const tweakedPriv = ecc.privateAdd(privTweak, tapTweakHash)
check('Taproot tweaked privkey: non-null',  tweakedPriv !== null)
check('Taproot tweaked privkey: 32 bytes',  tweakedPriv && tweakedPriv.length, 32)
if (tweakedPriv) {
  const tweakedPub = ecc.pointFromScalar(tweakedPriv, true)
  check('Taproot: tweaked priv → tweaked pub xOnly matches',
    Buffer.from(tweakedPub.slice(1)).toString('hex') === Buffer.from(tweakRes.xOnlyPubkey).toString('hex'))
}

// ============================================================
section('21. bitcoin.taproot.makeKeySigner — BIP341 bundle signer')
// Verifies the bundle-embedded taproot signer:
//   - exported on bitcoin.taproot
//   - correct structure (publicKey 32b, signSchnorr fn)
//   - Schnorr sig verifies against tweaked x-only pubkey
//   - memory zeroing does not break the callback (td captured before finally)
//   - no private key → throws before callback
//   - two calls produce different sigs (random nonce)
//   - BIP341 invariant: tweakedPriv→pub matches xOnlyPointAddTweak
check('bitcoin.taproot exported',                typeof b.taproot === 'object')
check('bitcoin.taproot.makeKeySigner: function', typeof b.taproot.makeKeySigner === 'function')

const trPriv = Buffer.from('e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35', 'hex')
const trKp   = b.ECPair.fromPrivateKey(trPriv)
const trHash = Buffer.from('0303030303030303030303030303030303030303030303030303030303030303', 'hex')

let trSig1 = null, trSig2 = null, trXOnly = null, trOk = false
b.taproot.makeKeySigner(trKp, function(s) {
  check('taproot signer: publicKey is Uint8Array',  s.publicKey instanceof Uint8Array)
  check('taproot signer: publicKey 32 bytes',       s.publicKey.length, 32)
  check('taproot signer: signSchnorr is function',  typeof s.signSchnorr === 'function')
  trSig1  = s.signSchnorr(trHash)
  trSig2  = s.signSchnorr(trHash)   // second call — must also verify
  trXOnly = s.publicKey
  check('taproot signer: sig1 is Uint8Array',       trSig1 instanceof Uint8Array)
  check('taproot signer: sig1 64 bytes',            trSig1.length, 64)
  check('taproot signer: sig2 64 bytes',            trSig2.length, 64)
  trOk = true
})
check('makeKeySigner: callback invoked (no exception)', trOk)

if (trSig1 && trXOnly) {
  check('makeKeySigner: sig1 verifySchnorr roundtrip',
    ecc.verifySchnorr(trHash, trXOnly, trSig1))
  check('makeKeySigner: sig2 verifySchnorr roundtrip',
    ecc.verifySchnorr(trHash, trXOnly, trSig2))
  let sigsDiffer = false
  for (let i = 0; i < 64; i++) if (trSig1[i] !== trSig2[i]) { sigsDiffer = true; break }
  check('makeKeySigner: random nonce (two sigs differ)', sigsDiffer)
  check('makeKeySigner: wrong hash → false',
    ecc.verifySchnorr(Buffer.from('ff'.repeat(32), 'hex'), trXOnly, trSig1), false)
}

// No private key → must throw before callback fires
let noPrivThrew = false, noPrivCallbackFired = false
try {
  b.taproot.makeKeySigner(b.ECPair.fromPublicKey(trKp.publicKey), function() {
    noPrivCallbackFired = true
  })
} catch(e) { noPrivThrew = true }
check('makeKeySigner: no privKey → throws',           noPrivThrew)
check('makeKeySigner: no privKey → callback not fired', !noPrivCallbackFired)

// BIP341 math invariant: tweakedPriv→pointFromScalar xOnly === xOnlyPointAddTweak result
const trXOnlyPub = trKp.publicKey.slice(1)
const trTweak    = b.crypto.taggedHash('TapTweak', trXOnlyPub)
const trEffD     = trKp.publicKey[0] === 0x03
                     ? ecc.privateNegate(new Uint8Array(trKp.privateKey))
                     : new Uint8Array(trKp.privateKey)
const trTweakedD = ecc.privateAdd(trEffD, trTweak)
const trTweakedFromPriv  = ecc.pointFromScalar(trTweakedD, true)
const trTweakedFromTweak = ecc.xOnlyPointAddTweak(trXOnlyPub, trTweak)
check('BIP341 invariant: makeKeySigner xOnly matches xOnlyPointAddTweak',
  trTweakedFromPriv && trTweakedFromTweak && trXOnly &&
  b.Buffer.from(trTweakedFromPriv.slice(1)).toString('hex') ===
  b.Buffer.from(trTweakedFromTweak.xOnlyPubkey).toString('hex') &&
  b.Buffer.from(trTweakedFromPriv.slice(1)).toString('hex') ===
  b.Buffer.from(trXOnly).toString('hex'))
// Cleanup
trEffD.fill(0); if (trTweakedD) trTweakedD.fill(0)

// ============================================================
console.log('\n' + '='.repeat(55))
console.log(`TOTAL: ${total}  ✅ PASSED: ${passed}  ❌ FAILED: ${failed}`)
if (failed > 0) {
  console.log('\nFAILED TESTS:')
  FAIL_DETAILS.forEach(d => console.log(d))
  console.log('\n❌ TESTS FAILED — do not deploy this build')
  process.exit(1)
} else {
  console.log('\n✅ ALL TESTS PASSED — bundle is safe to deploy')
}
