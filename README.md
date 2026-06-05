# Bitweb Web Wallet

A clean, self-contained browser wallet with a robust [ApiServer](https://github.com/bitweb-project/api-server) backend.

Feel free to modify and use it in your own projects.

**Live example:** [https://webwallet.bitwebcore.net](https://webwallet.bitwebcore.net)

---

## Features

### Address types

| Type | Format | Standard |
|------|--------|----------|
| Legacy | `1...` | P2PKH |
| Segwit (wrapped) | `3...` | P2SH-P2WPKH |
| Native SegWit | `btw1q...` | P2WPKH (Bech32) |
| Taproot | `btw1p...` | P2TR (Bech32m) |

All four types are available in Settings. HD derivation follows BIP44/49/84/86 per type.

### Non-custodial

Private keys never leave the browser. The wallet connects to an Electrum-based ApiServer for balance, UTXO and broadcast — it requires a live connection to function. No ApiServer, no wallet.

### Coin Control

UTXO-level transaction building: manually select which outputs to spend, sort by amount / confirmations / type / status. Selection persists in `localStorage` between sessions.

### Transaction History

Dedicated History tab showing incoming and outgoing transactions with amounts, confirmations and timestamps pulled from the ApiServer.

### Installable PWA

Ships a Web App Manifest and a minimal Service Worker — install directly from the browser address bar on desktop or mobile. No app store required. The Service Worker exists solely to satisfy the browser's install prompt requirement; asset caching is intentionally absent.

---

## Browser bundles

The wallet loads three pre-built browser bundles from `website/js/`. None of them are fetched from a CDN — all are vendored into the repo. Each bundle is fully reproducible from source using the pinned build guide in the repo root.

| File | Contents | Build guide |
|------|----------|-------------|
| `bitcoin-bundle-v7.min.js` | bitcoinjs-lib v7, ecpair, @noble/curves, Buffer polyfill, BIP341 taproot signer | [BUILD_Bitcoinjs.md](BUILD_Bitcoinjs.md) |
| `bip39-bundle.min.js` | @scure/bip39, @scure/bip32, HD key derivation | [BUILD_bip39.md](BUILD_bip39.md) |
| `qrcode-browser.min.js` | QR code canvas renderer | [BUILD_qrcode_browser.md](BUILD_qrcode_browser.md) |

All three bundles use only **MIT-licensed** dependencies. Build reproducibility is verified by SRI hashes documented in each guide.

## Dependencies

| Package | Version | License |
|---------|---------|---------|
| bitcoinjs-lib | 7.0.1 | MIT |
| ecpair | 3.0.1 | MIT |
| @noble/curves | 2.2.0 | MIT |
| @scure/bip39 | 2.2.0 | MIT |
| @scure/bip32 | 2.2.0 | MIT |
| buffer | 6.0.3 | MIT |
| qrcode | 1.5.4 | MIT |
| bootstrap | 5.x | MIT |
| jquery | 3.x | MIT |
| socket.io (client) | 4.8.1 | MIT |

---

## Security notes

- All cryptographic RNG goes through `window.crypto.getRandomValues` (Web Crypto API → OS CSPRNG). `Math.random` is absent from all bundles — verified by the build guides.
- Private key material (seed, root HDKey, child HDKey, taproot tweak) is zeroed with `fill(0)` after use throughout `wallet.js` and the bundle entry points.
- The BIP341 taproot signer (`bitcoin.taproot.makeKeySigner`) is co-located with the secp256k1 adapter in `entry_bundle.js` so all tweak arithmetic is auditable in one place.
- `@noble/curves` and `@scure/bip32`/`@scure/bip39` are audited by [Cure53](https://cure53.de/).

---

## License

[MIT](LICENSE.md)

---

*Originally inspired by OutCast3k's [coinbin](http://github.com/OutCast3k/coinbin).*
