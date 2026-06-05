(function() {
    'use strict';
    const walletVersion      = '0.1';
    const DEFAULT_DERIV_PATH = "m/84'/738'/0'/0/0";
    // P2TR dust threshold: DUST_RELAY_TX_FEE(3000) * (43 output + 67 input) / 1000 = 330 sat
    const DUST_LIMIT_SATS    = 330;
    const AUTO_LOCK_MS       = 20 * 60 * 1000;
    const UTXO_CACHE_TTL     = 60000;  // ms
    const STORAGE_KEY_PUB     = 'bte_wallet_pubkey';
    const STORAGE_KEY_PRIV    = 'bte_wallet_privkey';
    const STORAGE_KEY_SEED    = 'bte_wallet_seed';
    const STORAGE_KEY_PATH    = 'bte_wallet_path';
    const STORAGE_KEY_PRIV_PK = 'bte_wallet_privkey_pk';
    const STORAGE_KEY_SEED_PK = 'bte_wallet_seed_pk';
    const STORAGE_KEY_PK_ID   = 'bte_pk_credential_id';
    const STORAGE_KEY_CC_SORT  = 'bte_cc_sort';
    const PK_PRF_SALT = new TextEncoder().encode('bitweb-wallet-v1');
    let ccSort = (function() {
        try {
            const s = JSON.parse(localStorage.getItem(STORAGE_KEY_CC_SORT));
            if (s && ['amount','confs','type','status'].indexOf(s.col) >= 0 && ['asc','desc'].indexOf(s.dir) >= 0) return s;
        } catch(e) {}
        return { col: 'amount', dir: 'desc' };
    })();
    let cachedLanguage = null;
    const networkConfigs = {
        'BTE': {
            'uri':     'bitweb:',
            'title':   'Bitweb Wallet',
            'name':    'Main Network (BTE)',
            'api':     'https://api2.bitwebcore.net',
            'ticker':  'BTE',
            'decimals': 8,
            'fee':     0.0001,
            'network': {
                'messagePrefix': '\x19Bitweb Signed Message:\n',
                'bip32':   { 'public': 0x0488b21e, 'private': 0x0488ade4 },
                'bech32':  'web',
                'pubKeyHash': 0x21,
                'scriptHash': 0x1E,
                'wif':     0x80
            },
            'maturity': {
                'coinbase': 100,
                'extended': {
                    'enabled': true,
                    'start':   200,
                    'depth':   200
                }
            }
        }
    };
    const blockExplorer = {
        'address': function(address) { return 'https://explorertest.bitwebcore.net/address/' + encodeURIComponent(address) + '/' },
        'tx':      function(tx)      { return 'https://explorertest.bitwebcore.net/tx/' + encodeURIComponent(tx) + '/' }
    };
    let stream      = null;
    let scanVideo   = null;
    let scanRafId   = null;
    let scanSession = 0;
    let isSending = false;
    let autoLockTimer = null;
    let pinResolve         = null;
    let pinValidator       = null;
    let pinPasskeyCallback = null;
    class SeedStore {
        #pendingEntropy = null;
        #entropy        = null;
        #enc            = null;
        #tempKey        = null;
        #verifyPos      = [];
        #strength       = 256;
        setPending(arr) {
            this.wipePending();
            this.#pendingEntropy = arr; // take ownership, no copy
        }
        getPending()    { return this.#pendingEntropy; }
        wipePending() {
            if (this.#pendingEntropy) { this.#pendingEntropy.fill(0); this.#pendingEntropy = null; }
        }
        get entropy()      { return this.#entropy; }
        set entropy(v)     { this.#entropy = v; }
        get enc()          { return this.#enc; }
        set enc(v)         { this.#enc = v; }
        get tempKey()      { return this.#tempKey; }
        set tempKey(v)     { this.#tempKey = v; }
        get verifyPos()    { return this.#verifyPos; }
        set verifyPos(v)   { this.#verifyPos = v; }
        get strength()     { return this.#strength; }
        set strength(v)    { this.#strength = v; }
        clear() {
            this.wipePending();
            if (this.#entropy) { this.#entropy.fill(0); this.#entropy = null; }
            this.#enc       = null;
            this.#tempKey   = null;
            this.#verifyPos = [];
        }
    }
    const seedStore = new SeedStore();
    let ws       = null;
    let wsActive = false;
    let messages  = null;
    function applyTheme(mode) {
        const resolved = mode === 'auto'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : mode;
        document.documentElement.setAttribute('data-bs-theme', resolved);
        const labels = { light: getText('theme-light'), dark: getText('theme-dark'), auto: getText('theme-auto') };
        $('#theme-label').text(labels[mode] || getText('theme-auto'));
    }
    function setTheme(mode) {
        try { localStorage.setItem('bte_cfg_theme', mode) } catch(e) {}
        applyTheme(mode);
    }
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
        let saved; try { saved = localStorage.getItem('bte_cfg_theme') } catch(e) {}
        if ((saved || 'auto') === 'auto') applyTheme('auto');
    });
    function isValidBackendUrl(url) {
        try {
            const u = new URL(url);
            if (u.protocol !== 'https:' &&
                !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return false;
            if (u.username || u.password) return false;
            return true;
        } catch(e) { return false; }
    }
    function escHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
    function wipeInputValue(selector) {
        $(selector).each(function() {
            if (this && typeof this.value === 'string') {
                this.value = '';
            }
        });
    }
    function clearSensitiveInputs() {
        wipeInputValue('#open-email');
        wipeInputValue('#open-password');
        wipeInputValue('#open-password-confirm');
        wipeInputValue('#passphrase');
        wipeInputValue('#pin-input');
        wipeInputValue('#restore-input');
        wipeInputValue('#transaction-broadcast-raw');
    }
    function destroyKeyMaterial(keyPair) {
        if (!keyPair) return;
        try {
            if (keyPair.privateKey && keyPair.privateKey instanceof Uint8Array) {
                keyPair.privateKey.fill(0);
            }
        } catch (ignore) { /* not critical */ }
        try {
            if (keyPair.__D && keyPair.__D instanceof Uint8Array) {
                keyPair.__D.fill(0);
            }
        } catch (ignore) { /* not critical */ }
    }
    let revealedWif = null;
    function clearPrivKeyCanvas() {
        revealedWif = null;
        const canvas = document.getElementById('wallet-privkey-canvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        $('#privkey-reveal-row').addClass('d-none');
        $('#privkey-show-row').removeClass('d-none');
    }
    function revealPrivKeyCanvas(privBytes) {
        if (!Keystore.isUnlocked()) { privBytes.fill(0); return; }
        const kp = bitcoin.ECPair.fromPrivateKey(
            bitcoin.Buffer.from(privBytes), { network: getConfig()['network'] }
        );
        privBytes.fill(0);
        let wif = kp.toWIF();
        destroyKeyMaterial(kp);
        const canvas = document.getElementById('wallet-privkey-canvas');
        if (!canvas) { wif = null; return; }
        $('#privkey-show-row').addClass('d-none');
        $('#privkey-reveal-row').removeClass('d-none');
        revealedWif = wif;
        wif = null;
        requestAnimationFrame(function() {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const W = Math.max(canvas.offsetWidth || 340, 200);
            const H = Math.max(canvas.offsetHeight || 38, 32);
            canvas.width  = W * dpr;
            canvas.height = H * dpr;
            canvas.style.width = W + 'px';
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);
            const cs = getComputedStyle(document.body);
            ctx.fillStyle = cs.getPropertyValue('--bs-body-bg').trim() || '#ffffff';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle    = cs.getPropertyValue('--bs-body-color').trim() || '#212529';
            ctx.font         = '13px monospace';
            ctx.textBaseline = 'middle';
            ctx.fillText(revealedWif, 8, H / 2);
        });
    }
    class KeystoreClass {
        #pubKeyBytes = null;
        #tempKeyPair = null;
        getPublicKeyBytes() { return this.#pubKeyBytes; }
        isUnlocked() { return this.#pubKeyBytes !== null; }
        setPubOnly(pubBytes) {
            this.clearTempKeyPair();
            if (this.#pubKeyBytes) this.#pubKeyBytes.fill(0);
            this.#pubKeyBytes = new Uint8Array(pubBytes);
        }
        setTempKeyPair(kp) {
            this.clearTempKeyPair();
            if (this.#pubKeyBytes) this.#pubKeyBytes.fill(0);
            this.#pubKeyBytes = new Uint8Array(kp.publicKey);
            this.#tempKeyPair = kp;
        }
        getTempPrivBytes() {
            if (!this.#tempKeyPair || !this.#tempKeyPair.privateKey) return null;
            return new Uint8Array(this.#tempKeyPair.privateKey);
        }
        clearTempKeyPair() {
            if (this.#tempKeyPair) { destroyKeyMaterial(this.#tempKeyPair); this.#tempKeyPair = null; }
        }
        signAllInputsWithKey(psbt, privBytes) {
            if (!this.#pubKeyBytes) throw new Error('Wallet locked');
            const network = getConfig()['network'];
            const kp = bitcoin.ECPair.fromPrivateKey(bitcoin.Buffer.from(privBytes), { network: network });
            try {
                const hasTaproot = psbt.data.inputs.some(function(inp) {
                    return inp.tapInternalKey && inp.tapInternalKey.length === 32;
                });
                if (!hasTaproot) {
                    psbt.signAllInputs(kp);
                    return;
                }
                bitcoin.taproot.makeKeySigner(kp, function(tapSigner) {
                    psbt.data.inputs.forEach(function(inp, idx) {
                        if (inp.tapInternalKey && inp.tapInternalKey.length === 32) {
                            psbt.signInput(idx, tapSigner);
                        } else {
                            psbt.signInput(idx, kp);
                        }
                    });
                });
            } finally {
                destroyKeyMaterial(kp);
                privBytes.fill(0);
            }
        }
        deriveAddress(type, pubKey) {
            if (!this.#pubKeyBytes || !pubKey) return '';
            const network = getConfig()['network'];
            if (type === 'bech32') {
                return bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network }).address;
            } else if (type === 'segwit') {
                const redeem = bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network });
                return bitcoin.payments.p2sh({ redeem: redeem, network: network }).address;
            } else if (type === 'taproot') {
                const xOnlyPub = pubKey.length === 33 ? pubKey.slice(1) : pubKey;
                return bitcoin.payments.p2tr({ internalPubkey: xOnlyPub, network: network }).address;
            } else {
                return bitcoin.payments.p2pkh({ pubkey: pubKey, network: network }).address;
            }
        }
        getScriptHex(type, pubKey) {
            if (!this.#pubKeyBytes || !pubKey) return '';
            const network = getConfig()['network'];
            if (type === 'bech32') {
                return bitcoin.Buffer.from(bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network }).output).toString('hex');
            } else if (type === 'segwit') {
                const redeem = bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network });
                return bitcoin.Buffer.from(bitcoin.payments.p2sh({ redeem: redeem, network: network }).output).toString('hex');
            } else if (type === 'taproot') {
                const xOnlyPub = pubKey.length === 33 ? pubKey.slice(1) : pubKey;
                return bitcoin.Buffer.from(bitcoin.payments.p2tr({ internalPubkey: xOnlyPub, network: network }).output).toString('hex');
            } else {
                return bitcoin.Buffer.from(bitcoin.payments.p2pkh({ pubkey: pubKey, network: network }).output).toString('hex');
            }
        }
        getAllScriptHexes(pubKey) {
            const set = new Set();
            if (!this.#pubKeyBytes || !pubKey) return set;
            const network = getConfig()['network'];
            set.add(bitcoin.Buffer.from(bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network }).output).toString('hex').toLowerCase());
            const redeem = bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network });
            set.add(bitcoin.Buffer.from(bitcoin.payments.p2sh({ redeem: redeem, network: network }).output).toString('hex').toLowerCase());
            set.add(bitcoin.Buffer.from(bitcoin.payments.p2pkh({ pubkey: pubKey, network: network }).output).toString('hex').toLowerCase());
            try {
                const xOnlyPub = pubKey.length === 33 ? pubKey.slice(1) : pubKey;
                set.add(bitcoin.Buffer.from(bitcoin.payments.p2tr({ internalPubkey: xOnlyPub, network: network }).output).toString('hex').toLowerCase());
            } catch(e) {}
            return set;
        }
        getAllAddresses(pubKey) {
            const set = new Set();
            if (!this.#pubKeyBytes || !pubKey) return set;
            const network = getConfig()['network'];
            try { set.add(bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network }).address); } catch(e) {}
            try {
                const redeem = bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network });
                set.add(bitcoin.payments.p2sh({ redeem: redeem, network: network }).address);
            } catch(e) {}
            try { set.add(bitcoin.payments.p2pkh({ pubkey: pubKey, network: network }).address); } catch(e) {}
            try {
                const xOnlyPub = pubKey.length === 33 ? pubKey.slice(1) : pubKey;
                set.add(bitcoin.payments.p2tr({ internalPubkey: xOnlyPub, network: network }).address);
            } catch(e) {}
            return set;
        }
        clear() {
            this.clearTempKeyPair();
            if (this.#pubKeyBytes) { this.#pubKeyBytes.fill(0); this.#pubKeyBytes = null; }
        }
    }
    const Keystore = new KeystoreClass();
    async function deriveKey(pin, salt) {
        const enc = new TextEncoder();
        const km  = await crypto.subtle.importKey(
            'raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: salt, iterations: 300000, hash: 'SHA-256' },
            km,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }
    async function saveEncryptedBytes(storageKey, plainBytes, pin) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv   = crypto.getRandomValues(new Uint8Array(12));
        const key  = await deriveKey(pin, salt);
        const ct   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plainBytes);
        localStorage.setItem(storageKey, JSON.stringify({
            salt: Array.from(salt),
            iv:   Array.from(iv),
            data: Array.from(new Uint8Array(ct))
        }));
    }
    async function loadEncryptedBytes(storageKey, pin) {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        const blob = JSON.parse(raw);
        const key  = await deriveKey(pin, new Uint8Array(blob.salt));
        try {
            const pt = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: new Uint8Array(blob.iv) },
                key,
                new Uint8Array(blob.data)
            );
            return new Uint8Array(pt);
        } catch(e) { return null; }
    }
    async function saveEncryptedWithKeyBytes(storageKey, plaintextBytes, keyBytes) {
        const iv  = crypto.getRandomValues(new Uint8Array(12));
        const key = await crypto.subtle.importKey(
            'raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plaintextBytes);
        localStorage.setItem(storageKey, JSON.stringify({
            iv:   Array.from(iv),
            data: Array.from(new Uint8Array(ct))
        }));
    }
    async function loadEncryptedBytesWithKey(storageKey, keyBytes) {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        const blob = JSON.parse(raw);
        const key  = await crypto.subtle.importKey(
            'raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
        try {
            const pt = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: new Uint8Array(blob.iv) }, key, new Uint8Array(blob.data)
            );
            return new Uint8Array(pt);
        } catch(e) { return null; }
    }
    function savePublicKeyPlain(pubBytes) {
        try { localStorage.setItem(STORAGE_KEY_PUB, JSON.stringify(Array.from(pubBytes))); } catch(e) {}
    }
    function loadPublicKeyPlain() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_PUB);
            if (!raw) return null;
            return new Uint8Array(JSON.parse(raw));
        } catch(e) { return null; }
    }
    function askPrivKeyBytes(title, desc) {
        return new Promise(function(outerResolve) {
            let done = false;
            function finish(result) { if (!done) { done = true; outerResolve(result); } }
            async function onPasskeyChosen(retriesLeft) {
                if (retriesLeft === undefined) retriesLeft = 2;
                let credIdStr = null;
                try { credIdStr = localStorage.getItem(STORAGE_KEY_PK_ID); } catch(e) {}
                if (!credIdStr) { finish(null); return; }
                try {
                    const assertion = await navigator.credentials.get({
                        publicKey: {
                            challenge:        crypto.getRandomValues(new Uint8Array(32)),
                            rpId:             window.location.hostname,
                            allowCredentials: [{ type: 'public-key', id: b64ToCredId(credIdStr) }],
                            userVerification: 'required',
                            extensions:       { prf: { eval: { first: PK_PRF_SALT } } }
                        }
                    });
                    const ext = assertion.getClientExtensionResults();
                    if (!ext.prf || !ext.prf.results || !ext.prf.results.first) {
                        showMessage(escHtml(getText('passkey-prf-unsupported'))); finish(null); return;
                    }
                    const prfBytes  = new Uint8Array(ext.prf.results.first);
                    const privBytes = await loadEncryptedBytesWithKey(STORAGE_KEY_PRIV_PK, prfBytes);
                    prfBytes.fill(0);
                    if (!privBytes) { showMessage(escHtml(getText('passkey-decrypt-failed'))); finish(null); return; }
                    finish(privBytes);
                } catch(e) {
                    if (e.name === 'NotAllowedError') { finish(null); return; }
                    if (retriesLeft > 0 && isTransientPasskeyError(e)) {
                        await new Promise(function(r) { setTimeout(r, 300); });
                        return onPasskeyChosen(retriesLeft - 1);
                    }
                    showMessage(escHtml(getText('passkey-error')) + escHtml(e.message));
                    finish(null);
                }
            }
            const validator = async function(candidate) {
                const priv = await loadEncryptedBytes(STORAGE_KEY_PRIV, candidate);
                if (!priv) return getText('pin-login-error');
                priv.fill(0);
                return null;
            };
            askPin(title, desc, validator, false, isPasskeyEnabled() ? onPasskeyChosen : null)
                .then(async function(pin) {
                    if (pin === null) { finish(null); return; }
                    const privBytes = await loadEncryptedBytes(STORAGE_KEY_PRIV, pin);
                    pin = null;
                    finish(privBytes);
                });
        });
    }
    function credIdToB64(rawId) {
        return btoa(String.fromCharCode.apply(null, new Uint8Array(rawId)));
    }
    function b64ToCredId(b64) {
        return Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); });
    }
    function isPasskeyEnabled() {
        try {
            return localStorage.getItem(STORAGE_KEY_PK_ID)   !== null &&
                   localStorage.getItem(STORAGE_KEY_PRIV_PK) !== null;
        } catch(e) { return false; }
    }
    function hasSeedPkBackup() {
        try { return localStorage.getItem(STORAGE_KEY_SEED_PK) !== null; } catch(e) { return false; }
    }
    async function checkPasskeySupport() {
        if (!window.PublicKeyCredential) return false;
        return !!(navigator.credentials && navigator.credentials.create);
    }
    function isTransientPasskeyError(e) {
        if (!e || !e.message) return false;
        const m = e.message.toLowerCase();
        return m.indexOf('transient') !== -1 || m.indexOf('unknown') !== -1;
    }
    async function pkEnable() {
        const pkEnableValidator = async function(candidate) {
            const priv = await loadEncryptedBytes(STORAGE_KEY_PRIV, candidate);
            if (!priv) return getText('pin-login-error');
            priv.fill(0);
            return null;
        };
        let pin = await askPin(
            getText('pin-title-default'),
            (getText('passkey-confirm-pin')),
            pkEnableValidator, false
        );
        if (pin === null) return;
        const privBytes = await loadEncryptedBytes(STORAGE_KEY_PRIV, pin);
        if (!privBytes) { pin = null; return; }
        const seedBytes = await loadEncryptedBytes(STORAGE_KEY_SEED, pin);
        pin = null;
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const userId    = crypto.getRandomValues(new Uint8Array(16));
        try {
            const credential = await navigator.credentials.create({
                publicKey: {
                    challenge: challenge,
                    rp:  {
                        name: getConfig()['title'] || 'Bitweb Wallet',
                        id:   window.location.hostname
                    },
                    user: {
                        id:          userId,
                        name:        'wallet',
                        displayName: 'Bitweb Wallet'
                    },
                    pubKeyCredParams: [
                        { type: 'public-key', alg: -7   },  // ES256
                        { type: 'public-key', alg: -257 }   // RS256
                    ],
                    authenticatorSelection: {
                        userVerification: 'required',
                        residentKey:      'preferred'
                    },
                    extensions: {
                        prf: { eval: { first: PK_PRF_SALT } }
                    }
                }
            });
            const ext = credential.getClientExtensionResults();
            if (!ext.prf || !ext.prf.results || !ext.prf.results.first) {
                privBytes.fill(0); if (seedBytes) seedBytes.fill(0);
                showMessage(escHtml(getText('passkey-prf-unsupported')));
                return;
            }
            const prfBytes = new Uint8Array(ext.prf.results.first);
            await saveEncryptedWithKeyBytes(STORAGE_KEY_PRIV_PK, privBytes, prfBytes);
            if (seedBytes) await saveEncryptedWithKeyBytes(STORAGE_KEY_SEED_PK, seedBytes, prfBytes);
            prfBytes.fill(0);
            privBytes.fill(0); if (seedBytes) seedBytes.fill(0);
            localStorage.setItem(STORAGE_KEY_PK_ID, credIdToB64(credential.rawId));
            updatePasskeyUI();
            showMessage(escHtml(getText('passkey-enabled')));
        } catch(e) {
            if (privBytes) privBytes.fill(0);
            if (seedBytes) seedBytes.fill(0);
            if (e.name === 'NotAllowedError') return;
            showMessage(escHtml(getText('passkey-error')) + escHtml(e.message));
        }
    }
    async function pkAuthenticate(retriesLeft) {
        if (retriesLeft === undefined) retriesLeft = 2;
        let credIdStr = null;
        try { credIdStr = localStorage.getItem(STORAGE_KEY_PK_ID); } catch(e) {}
        if (!credIdStr) { showMessage(escHtml(getText('passkey-not-setup'))); return; }
        const credIdBytes = b64ToCredId(credIdStr);
        try {
            await navigator.credentials.get({
                publicKey: {
                    challenge:         crypto.getRandomValues(new Uint8Array(32)),
                    rpId:              window.location.hostname,
                    allowCredentials:  [{ type: 'public-key', id: credIdBytes }],
                    userVerification:  'required',
                    extensions: { prf: { eval: { first: PK_PRF_SALT } } }
                }
            });
            const pubBytes = loadPublicKeyPlain();
            if (!pubBytes) { showMessage(escHtml(getText('passkey-decrypt-failed'))); return; }
            Keystore.setPubOnly(pubBytes);
            globalData.pubKey = pubBytes;
            await openWallet(false);
        } catch(e) {
            if (e.name === 'NotAllowedError') return;
            if (retriesLeft > 0 && isTransientPasskeyError(e)) {
                await new Promise(function(r) { setTimeout(r, 300); });
                return pkAuthenticate(retriesLeft - 1);
            }
            showMessage(escHtml(getText('passkey-error')) + escHtml(e.message));
        }
    }
    function doPkDisable() {
        [STORAGE_KEY_PRIV_PK, STORAGE_KEY_SEED_PK, STORAGE_KEY_PK_ID].forEach(function(k) {
            try { localStorage.removeItem(k); } catch(e) {}
        });
        updatePasskeyUI();
        showMessage(escHtml(getText('passkey-disabled')));
    }
    async function pkDisable() {
        async function onPasskeyChosen(retriesLeft) {
            if (retriesLeft === undefined) retriesLeft = 2;
            let credIdStr = null;
            try { credIdStr = localStorage.getItem(STORAGE_KEY_PK_ID); } catch(e) {}
            if (!credIdStr) return;
            try {
                await navigator.credentials.get({
                    publicKey: {
                        challenge:         crypto.getRandomValues(new Uint8Array(32)),
                        rpId:              window.location.hostname,
                        allowCredentials:  [{ type: 'public-key', id: b64ToCredId(credIdStr) }],
                        userVerification:  'required',
                        extensions:        { prf: { eval: { first: PK_PRF_SALT } } }
                    }
                });
                doPkDisable();
            } catch(e) {
                if (e.name === 'NotAllowedError') return;
                if (retriesLeft > 0 && isTransientPasskeyError(e)) {
                    await new Promise(function(r) { setTimeout(r, 300); });
                    return onPasskeyChosen(retriesLeft - 1);
                }
                showMessage(escHtml(getText('passkey-error')) + escHtml(e.message));
            }
        }
        const pkDisableValidator = async function(candidate) {
            const priv = await loadEncryptedBytes(STORAGE_KEY_PRIV, candidate);
            if (!priv) return getText('pin-login-error');
            priv.fill(0);
            return null;
        };
        let pin = await askPin(
            getText('pin-title-default'),
            getText('passkey-disable-confirm'),
            pkDisableValidator, false,
            onPasskeyChosen
        );
        if (pin === null) return;
        pin = null;
        doPkDisable();
    }
    function updatePasskeyUI() {
        updatePasskeySettingsUI();
    }
    function updatePasskeySettingsUI() {
        const $section = $('#passkey-settings-section');
        if (!$section.length) return;
        if (isPasskeyEnabled()) {
            $('#passkey-settings-status').text(getText('passkey-status-enabled'));
            $('#passkey-settings-btn')
                .text(getText('passkey-disable-btn'))
                .removeClass('btn-outline-primary btn-success')
                .addClass('btn-outline-danger');
        } else {
            $('#passkey-settings-status').text(getText('passkey-status-disabled'));
            $('#passkey-settings-btn')
                .text(getText('passkey-enable-btn'))
                .removeClass('btn-outline-danger btn-success')
                .addClass('btn-outline-primary');
        }
        $section.removeClass('d-none');
    }
    async function saveWalletWif(pin) {
        const privBytes = Keystore.getTempPrivBytes();
        if (!privBytes) throw new Error('Private key is not available');
        const pubCopy = new Uint8Array(globalData.pubKey);
        try {
            savePublicKeyPlain(pubCopy);
            await saveEncryptedBytes(STORAGE_KEY_PRIV, privBytes, pin);
            localStorage.removeItem(STORAGE_KEY_SEED);
            localStorage.removeItem(STORAGE_KEY_PATH);
        } finally {
            pubCopy.fill(0);
            privBytes.fill(0);
        }
    }
    async function saveWalletBip39(entropyBytes, pin, path) {
        const privBytes = Keystore.getTempPrivBytes();
        if (!privBytes) throw new Error('Private key is not available');
        const pubCopy = new Uint8Array(globalData.pubKey);
        try {
            savePublicKeyPlain(pubCopy);
            await Promise.all([
                saveEncryptedBytes(STORAGE_KEY_PRIV, privBytes,    pin),
                saveEncryptedBytes(STORAGE_KEY_SEED, entropyBytes, pin)
            ]);
            try { localStorage.setItem(STORAGE_KEY_PATH, path || DEFAULT_DERIV_PATH); } catch(e) {}
        } finally {
            pubCopy.fill(0);
            privBytes.fill(0);
        }
    }
    function resetAutoLock() {
        if (!Keystore.isUnlocked()) return;
        clearTimeout(autoLockTimer);
        autoLockTimer = setTimeout(function() {
            closeWallet();
            showMessage(escHtml(getText('auto-locked')));
        }, AUTO_LOCK_MS);
    }
    function stopAutoLock() {
        clearTimeout(autoLockTimer);
        autoLockTimer = null;
    }
    function hasSeedBackup() {
        return localStorage.getItem(STORAGE_KEY_SEED) !== null;
    }
    function clearSeedState() {
        seedStore.clear();
    }
    function askPin(title, desc, validator, mandatory, onPasskeyClick) {
        return new Promise(function(resolve) {
            pinResolve         = resolve;
            pinValidator       = validator || null;
            pinPasskeyCallback = null;
            $('#pin-modal-title').text(title);
            $('#pin-modal-desc').text(desc);
            $('#pin-input').val('');
            $('#pin-error').addClass('d-none');
            if (mandatory) {
                $('#pin-cancel').addClass('d-none');
            } else {
                $('#pin-cancel').removeClass('d-none');
            }
            if (onPasskeyClick && isPasskeyEnabled()) {
                pinPasskeyCallback = onPasskeyClick;
                $('#pin-modal-pk-btn').removeClass('d-none');
            } else {
                $('#pin-modal-pk-btn').addClass('d-none');
            }
            bootstrap.Modal.getOrCreateInstance(document.getElementById('pin-modal'), { backdrop: 'static', keyboard: false }).show();
            setTimeout(function() { $('#pin-input').focus(); }, 400);
        });
    }
    function validatePinStrength(p) {
        if (!p || p.length < 8)          return getText('pin-too-short');
        if (!/[A-Z]/.test(p))            return getText('pin-need-upper');
        if (!/[a-z]/.test(p))            return getText('pin-need-lower');
        if (!/[0-9]/.test(p))            return getText('pin-need-digit');
        if (!/[^A-Za-z0-9]/.test(p))     return getText('pin-need-special');
        return null;
    }
    async function askPinSetup() {
        let pin = await askPin(
            getText('pin-create-title'),
            getText('pin-create-desc'),
            validatePinStrength,
            false
        );
        if (pin === null) return null;
        const sentinel = crypto.getRandomValues(new Uint8Array(32));
        const salt     = crypto.getRandomValues(new Uint8Array(16));
        const iv       = crypto.getRandomValues(new Uint8Array(12));
        const key1     = await deriveKey(pin, salt);
        const ct       = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv }, key1, sentinel
        ));
        pin = null;
        const confirmValidator = async function(candidate) {
            try {
                const key2 = await deriveKey(candidate, salt);
                const pt   = new Uint8Array(await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: iv }, key2, ct
                ));
                pt.fill(0);
                return null;
            } catch(e) {
                return getText('pin-mismatch');
            }
        };
        const confirmed = await askPin(
            getText('pin-confirm-title'),
            getText('pin-confirm-desc'),
            confirmValidator,
            false
        );
        sentinel.fill(0); ct.fill(0);
        return confirmed;
    }
    function initMessages() {
        return {
            'settings': {
                'typeSwitched':     function(type) { return getText('address-type-changed') + ' <b>' + escHtml(type) + '</b>'; },
                'backendSwitched':  function(url)  { return getText('backend-switched') + ' <b>' + escHtml(url) + '</b>'; },
                'backendNotWorking': function(url) { return '<b>' + escHtml(url) + '</b> ' + getText('backend-down'); }
            },
            'error': {
                'bad-utxo':            getText('bad-utxo'),
                'balance-load-failed': getText('balance-load-failed'),
                'not-enough-funds':    getText('not-enough-funds'),
                'not-valid-address':   getText('not-valid-address'),
                'not-valid-amount':    getText('not-valid-amount'),
                'not-valid-fee':       getText('not-valid-fee'),
                'bad-priv-key':        getText('bad-priv-key'),
                'not-enough-utxo':     getText('not-enough-utxo'),
                'broadcast-failed':    getText('broadcast-failed'),
                'pass-not-match':      getText('pass-not-match'),
                'pass-too-short':      getText('pass-too-short'),
                'small-fee':           getText('small-fee') + ' ' + getConfig()['fee'] + ' ' + getConfig()['ticker'] + '!'
            },
            'tx': {
                'loading-utxo': getText('loading-utxo'),
                'generating':   getText('transaction-creation'),
                'success':      getText('transaction-broadcasted')
            },
            'title': {
                'sure':       getText('send-sure'),
                'processing': getText('send-processing'),
                'success':    getText('success'),
                'failed':     getText('failed')
            },
            'misc': {
                'outputAdded': function(address) {
                    return getText('address') + ' ' + '<b class="break-word">' + escHtml(address) + '</b>' + ' ' + getText('outputs-added');
                }
            }
        };
    }
    function initLang() {
        let language; try { language = localStorage.getItem('bte_cfg_language'); } catch(e) {}
        let setLang = 'en';
        if (language == null || walletLanguages[language] == undefined) {
            const userLang = navigator.language.slice(0, 2);
            if (userLang in walletLanguages) setLang = userLang;
            try { localStorage.setItem('bte_cfg_language', setLang); } catch(e) {}
            language = setLang;
        }
        const $menu = $('#lang-dropdown-menu');
        $menu.empty();
        for (const key in walletLanguages) {
            const isActive = (key === language) ? ' active' : '';
            $menu.append(
                '<li><a class="dropdown-item lang-switch-item' + isActive + '" href="#" data-lang="' + escHtml(key) + '">' +
                escHtml(walletLanguages[key]['lang-alias']) + '</a></li>'
            );
        }
        cachedLanguage = language;
        $('#lang-label').text('🌐 ' + (walletLanguages[language] ? walletLanguages[language]['lang-alias'] : language));
        $('[tkey]').each(function() {
            if (['INPUT', 'TEXTAREA'].indexOf($(this).prop('tagName')) >= 0) {
                $(this).attr('placeholder', getText($(this).attr('tkey')));
            } else {
                $(this).html(getText($(this).attr('tkey')));
            }
        });
        $('[data-tkey-title]').each(function() {
            $(this).attr('title', getText($(this).attr('data-tkey-title')));
        });
        messages = initMessages();
        setHomeTitle();
        return language;
    }
    function getText(token) {
        let language = cachedLanguage;
        if (language == null) {
            try { language = localStorage.getItem('bte_cfg_language'); } catch(e) {}
            if (language == null || walletLanguages[language] == undefined) {
                language = initLang();
            } else {
                cachedLanguage = language;
            }
        }
        if (token in walletLanguages[language]) return walletLanguages[language][token];
        return walletLanguages['en'][token];
    }
    function getConfig() {
        let network; try { network = localStorage.getItem('bte_cfg_network'); } catch(e) {}
        if (network == null || networkConfigs[network] == undefined) {
            network = Object.keys(networkConfigs)[0];
            try { localStorage.setItem('bte_cfg_network', network); } catch(e) {}
        }
        return networkConfigs[network];
    }
    function switchConfig(network, page) {
        page = page || '';
        network = network.toUpperCase();
        if (networkConfigs[network] != undefined && networkConfigs[network] != getConfig()) {
            try { localStorage.setItem('bte_cfg_network', network); } catch(e) {}
            closeWallet();
            switchBackend(networkConfigs[network]['api']);
        }
        switchPage(page);
    }
    function getAddressType() {
        let type; try { type = localStorage.getItem('bte_cfg_type'); } catch(e) {}
        if (type == null || !['bech32', 'segwit', 'legacy', 'taproot'].includes(type)) {
            type = 'taproot';
            try { localStorage.setItem('bte_cfg_type', type); } catch(e) {}
        }
        return type;
    }
    function switchAddressType(type) {
        if (['bech32', 'segwit', 'legacy', 'taproot'].includes(type)) try { localStorage.setItem('bte_cfg_type', type); } catch(e) {}
    }
    function getBackend() {
        let backend; try { backend = localStorage.getItem('bte_cfg_backend'); } catch(e) {}
        if (backend == null) {
            backend = getConfig()['api'];
            try { localStorage.setItem('bte_cfg_backend', backend); } catch(e) {}
        }
        return backend;
    }
    async function switchBackend(url) {
        if (!isValidBackendUrl(url)) {
            showMessage(messages.settings.backendNotWorking(url));
            $('#wallet-backend input').val(getBackend());
            return;
        }
        try {
            await Promise.resolve($.ajax({ 'url': url + '/info' }));
            try { localStorage.setItem('bte_cfg_backend', url); } catch(e) {}
            showMessage(messages.settings.backendSwitched(url));
        } catch(e) {
            showMessage(messages.settings.backendNotWorking(url));
            $('#wallet-backend input').val(getBackend());
        }
    }
    const globalData = {
        status:             'locked',
        balance:             0,
        unconfirmedBalance:  0,
        immatureBalance:     0,
        pendingOut:          0,
        height:              0,
        address:         undefined,
        scriptHex:       undefined,
        pubKey:          null,
        rfee:            getConfig()['fee'],
        utxos:           [],
        coinControl:     false,
        selectedUtxos:   null,
        tx:              { amount: 0, outputs: [], fee: 0 },
        lastRendered:   { balance: -1, immature: -1, unconfirmed: -1, pendingOut: -1, utxoFingerprint: '' },
        resetTx: function() {
            this.tx = { amount: 0, outputs: [], fee: 0 };
        },
        clear: function() {
            this.status          = 'locked';
            this.address         = '';
            this.scriptHex       = undefined;
            if (this.pubKey instanceof Uint8Array) this.pubKey.fill(0);
            this.pubKey          = null;
            this.allScriptHexes  = null;
            this.allAddresses    = null;
            this.balance             = 0;
            this.unconfirmedBalance  = 0;
            this.immatureBalance     = 0;
            this.pendingOut          = 0;
            this.height              = 0;
            this.utxos               = [];
            this.coinControl         = false;
            this.selectedUtxos       = null;
            this.lastRendered       = { balance: -1, immature: -1, unconfirmed: -1, pendingOut: -1, utxoFingerprint: '' };
            this.resetTx();
        }
    };
    TxHistory.init({
        globalData:    globalData,
        escHtml:       escHtml,
        getText:       getText,
        getBackend:    getBackend,
        getConfig:     getConfig,
        amountFormat:  amountFormat,
        blockExplorer: blockExplorer
    });
    async function copyToClipboard(text, $btn) {
        const doFeedback = function(ok) {
            const $icon    = $btn.find('.fa-solid, .fa-regular, .fa-brands').first();
            const origClass = $icon.attr('class');
            if ($icon.length) {
                $icon.attr('class', 'fa-solid ' + (ok ? 'fa-check' : 'fa-times'));
            }
            $btn.addClass(ok ? 'btn-success' : 'btn-danger').removeClass('btn-outline-secondary');
            setTimeout(function() {
                if ($icon.length) $icon.attr('class', origClass);
                $btn.removeClass('btn-success btn-danger').addClass('btn-outline-secondary');
            }, 1500);
        };
        try {
            await navigator.clipboard.writeText(text);
            doFeedback(true);
        } catch(e) {
            doFeedback(false);
        }
    }
    function showMessage(message) {
        $('#error-message').html(message);
        $('#error-message').removeClass('d-none');
        setTimeout(function() { $('#error-message').addClass('d-none'); }, 3400);
    }
    function showSendError(message) {
        isSending = false;
        $('#send-modal-error').text(message).removeClass('d-none');
        $('#confirm-screen').addClass('d-none');
        $('#status-screen').addClass('d-none');
        $('#send-cancel').prop('disabled', false).removeClass('disabled d-none');
        $('#send-confirm').prop('disabled', false).addClass('d-none');
        $('#send-close-footer').addClass('d-none disabled');
        if (!document.getElementById('send-modal').classList.contains('show')) {
            $('#send-title').text(messages.title['sure']);
            bootstrap.Modal.getOrCreateInstance(document.getElementById('send-modal')).show();
        }
    }
    function showQrAddress(text) {
        const container = document.getElementById('qr-code-address');
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        container.appendChild(canvas);
        QRCode.toCanvas(canvas, text, { width: 256, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    }
    function setHomeTitle() {
        if (Keystore.isUnlocked()) setTitle(getText('address') + ' ' + globalData.address);
        else setTitle(getText('open-wallet'));
    }
    function getRequiredMaturity(coinHeight) {
        const cfg = getConfig()['maturity'];
        if (!cfg) return 100;
        const m   = cfg.coinbase || 100;
        const ext = cfg.extended;
        if (ext && ext.enabled) {
            const EXT_END = ext.start + ext.depth;
            if (coinHeight >= ext.start && coinHeight < EXT_END) {
                return (EXT_END - coinHeight) + m;
            }
        }
        return m;
    }
    function isUtxoMature(utxo, currentHeight) {
        const h = Number(utxo.height);
        if (!Number.isFinite(h) || h <= 0) return false;
        if (!utxo.coinbase) return true;
        const required = getRequiredMaturity(h);
        return (currentHeight - h) >= required;
    }
    function blocksToMature(utxo, currentHeight) {
        const h = Number(utxo.height);
        if (!utxo.coinbase || !Number.isFinite(h) || h <= 0) return 0;
        const required = getRequiredMaturity(h);
        return Math.max(0, required - (currentHeight - h));
    }
    function loadUtxoCache(address) {
        try {
            const raw = localStorage.getItem('bte_utxo_' + address);
            if (!raw) return null;
            const c = JSON.parse(raw);
            if (Date.now() - c.ts > UTXO_CACHE_TTL) return null;
            return c;
        } catch(e) { return null; }
    }
    function saveUtxoCache(address, utxos, height, balance, pendingOut) {
        try {
            localStorage.setItem('bte_utxo_' + address, JSON.stringify({
                utxos: utxos, height: height, balance: balance || 0,
                pendingOut: pendingOut || 0, ts: Date.now()
            }));
        } catch(e) {}
    }
    function clearUtxoCache(address) {
        try { localStorage.removeItem('bte_utxo_' + address); } catch(e) {}
    }
    function applyUtxoData() {
        let immature    = 0;
        let unconfirmed = 0;
        globalData.utxos.forEach(function(u) {
            if (u.height === 0)   unconfirmed += u.value;
            else if (!u.mature)   immature    += u.value;
        });
        globalData.immatureBalance    = immature;
        globalData.unconfirmedBalance = unconfirmed;
        const fp = globalData.utxos.map(function(u) {
            return u.txid + ':' + u.index + ':' + (u.mature ? 1 : 0);
        }).join('|');
        const fpChanged = fp !== globalData.lastRendered.utxoFingerprint;
        if (fpChanged) {
            globalData.lastRendered.utxoFingerprint = fp;
            renderCoinControl();
        }
        renderBalanceDisplay();
    }
    function amountFormat(amount) {
        const decimals = getConfig()['decimals'];
        let sats = String(Math.round(Math.abs(Number(amount))));
        while (sats.length <= decimals) sats = '0' + sats;
        const intPart  = sats.slice(0, sats.length - decimals) || '0';
        const fracPart = sats.slice(sats.length - decimals);
        return intPart + '.' + fracPart;
    }
    function renderBalanceDisplay() {
        const confirmed   = globalData.balance;
        const immature    = globalData.immatureBalance;
        const unconfirmed = globalData.unconfirmedBalance;
        const pendingOut  = globalData.pendingOut || 0;
        const avail       = Math.max(0, confirmed - immature - pendingOut);
        const lr = globalData.lastRendered;
        if (lr.balance === confirmed && lr.immature === immature && lr.unconfirmed === unconfirmed && lr.pendingOut === pendingOut) return;
        lr.balance     = confirmed;
        lr.immature    = immature;
        lr.unconfirmed = unconfirmed;
        lr.pendingOut  = pendingOut;
        const ticker = getConfig()['ticker'];
        $('.wallet-balance .amount').text(amountFormat(avail));
        $('.wallet-balance .ticker').text(ticker);
        const immatureText = immature > 0 ? amountFormat(immature) + ' ' + ticker : '';
        $('#immature-balance-row-main, #immature-balance-row').each(function() {
            if (immature > 0) {
                $(this).find('.immature-amount').text(immatureText);
                $(this).removeClass('d-none');
            } else {
                $(this).addClass('d-none');
            }
        });
        const unconfirmedText = unconfirmed > 0 ? amountFormat(unconfirmed) + ' ' + ticker : '';
        $('#unconfirmed-balance-row-main, #unconfirmed-balance-row').each(function() {
            if (unconfirmed > 0) {
                $(this).find('.unconfirmed-amount').text(unconfirmedText);
                $(this).removeClass('d-none');
            } else {
                $(this).addClass('d-none');
            }
        });
        validateSendForm();
    }
    function saveCcSort() {
        try { localStorage.setItem(STORAGE_KEY_CC_SORT, JSON.stringify(ccSort)); } catch(e) {}
    }
    function updateCcSortIcons() {
        $('.cc-sort-th').each(function() {
            const col  = $(this).data('sort');
            const icon = $(this).find('.cc-sort-icon');
            if (col === ccSort.col) {
                icon.removeClass('fa-sort fa-sort-up fa-sort-down')
                    .addClass(ccSort.dir === 'asc' ? 'fa-sort-up' : 'fa-sort-down');
                $(this).addClass('cc-sort-active');
            } else {
                icon.removeClass('fa-sort-up fa-sort-down').addClass('fa-sort');
                $(this).removeClass('cc-sort-active');
            }
        });
    }
    function sortUtxos(utxos) {
        const height = globalData.height;
        const col = ccSort.col;
        const dir = ccSort.dir === 'asc' ? 1 : -1;
        return utxos.slice().sort(function(a, b) {
            let va, vb;
            if (col === 'amount') {
                va = a.value; vb = b.value;
            } else if (col === 'confs') {
                va = (height > 0 && a.height > 0) ? (height - a.height + 1) : -1;
                vb = (height > 0 && b.height > 0) ? (height - b.height + 1) : -1;
            } else if (col === 'type') {
                va = a.coinbase ? 1 : 0; vb = b.coinbase ? 1 : 0;
            } else if (col === 'status') {
                function statusRank(u) {
                    if (Number(u.height) === 0) return 2;
                    if (!u.mature)              return 1;
                    return 0;
                }
                va = statusRank(a); vb = statusRank(b);
            }
            if (va < vb) return -1 * dir;
            if (va > vb) return  1 * dir;
            return 0;
        });
    }
    function renderCoinControl() {
        const utxos  = globalData.utxos;
        const height = globalData.height;
        const tbody  = $('#coin-control-tbody');
        tbody.empty();
        updateCcSortIcons();
        if (utxos.length === 0) {
            tbody.append('<tr><td colspan="5" class="text-muted text-center">' + escHtml(getText('coin-control-no-utxo')) + '</td></tr>');
            updateCoinControlInfo();
            return;
        }
        $('#coin-control-enable').prop('checked', globalData.coinControl);
        const sorted = sortUtxos(utxos);
        sorted.forEach(function(u) {
            const key       = escHtml(u.txid + ':' + u.index);
            const confirmed = Number(u.height) > 0;
            const mature    = u.mature;
            const spendable = confirmed && mature;
            const checked   = globalData.coinControl && globalData.selectedUtxos && globalData.selectedUtxos.has(u.txid + ':' + u.index);
            const isCbase   = u.coinbase;
            const disabled  = (!globalData.coinControl || !spendable) ? 'disabled' : '';
            const rowClass  = (!spendable) ? 'text-muted' : '';
            let status       = '';
            let disabledTitle = '';
            if (!confirmed) {
                status = '<span class="text-secondary"><span class="fa-solid fa-hourglass-half"></span> <span tkey="history-pending">' + escHtml(getText('history-pending')) + '</span></span>';
                disabledTitle = ' title="' + escHtml(getText('coin-control-unconfirmed-title')) + '"';
            } else if (!mature) {
                status = '<span class="text-warning" title="' + escHtml(getText('coin-control-matures-in')) + ' ' + escHtml(String(u.blocksLeft)) + ' ' + escHtml(getText('coin-control-blocks')) + '">' +
                    '<span class="fa-solid fa-lock"></span> ' + escHtml(String(u.blocksLeft)) + ' blk</span>';
                disabledTitle = ' title="' + escHtml(getText('coin-control-immature-title')) + '"';
            } else {
                status = '<span class="text-success"><span class="fa-solid fa-unlock"></span> <span tkey="coin-control-mature">' + escHtml(getText('coin-control-mature')) + '</span></span>';
            }
            const typeLabel = isCbase
                ? '<span class="badge text-bg-secondary" tkey="coin-control-coinbase">' + escHtml(getText('coin-control-coinbase')) + '</span>'
                : '<span class="badge text-bg-secondary" tkey="coin-control-regular">' + escHtml(getText('coin-control-regular')) + '</span>';
            const amt     = amountFormat(u.value);
            tbody.append(
                '<tr class="' + rowClass + '" data-key="' + key + '">' +
                '<td><input type="checkbox" class="cc-utxo-check" data-key="' + key + '"' +
                (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + (!spendable ? disabledTitle : '') + '></td>' +
                '<td class="font-monospace">' + escHtml(String(amt)) + '</td>' +
                '<td>' + (height > 0 && u.height > 0 ? escHtml(String(height - u.height + 1)) : '—') + '</td>' +
                '<td>' + typeLabel + '</td>' +
                '<td>' + status + '</td>' +
                '</tr>'
            );
        });
        updateCoinControlInfo();
    }
    function updateCoinControlInfo() {
        if (!globalData.coinControl || !globalData.selectedUtxos) {
            $('#coin-control-selected-info').text('');
            return;
        }
        let total = 0, count = 0;
        globalData.utxos.forEach(function(u) {
            const key = u.txid + ':' + u.index;
            if (globalData.selectedUtxos.has(key)) { total += u.value; count++; }
        });
        $('#coin-control-selected-info').text(
            count + ' ' + getText('coin-control-selected') + ' — ' + amountFormat(total) + ' ' + getConfig()['ticker']
        );
    }
    function parseAmountSats(str) {
        const decimals = getConfig()['decimals'];
        str = String(str == null ? '' : str).trim();
        if (str === '' || str === '.') return null;
        if (!/^\d+\.?\d*$/.test(str)) return null;
        const parts   = str.split('.');
        const intPart = parts[0] || '0';
        let fracPart  = (parts[1] || '').slice(0, decimals);
        while (fracPart.length < decimals) fracPart += '0';
        const sats = parseInt(intPart, 10) * Math.pow(10, decimals) + parseInt(fracPart || '0', 10);
        return Math.round(sats);
    }
    function filterAmountStr(val, decimals) {
        val = val.replace(/[^\d.]/g, '');
        const dotIdx = val.indexOf('.');
        if (decimals === 0) {
            val = val.replace(/\./g, '');
        } else if (dotIdx >= 0) {
            const before = val.slice(0, dotIdx + 1);
            const after  = val.slice(dotIdx + 1).replace(/\./g, '').slice(0, decimals);
            val = before + after;
        }
        return val;
    }
    function validateSendForm() {
        if (globalData.status !== 'unlocked') {
            $('#send-tx').prop('disabled', true);
            return;
        }
        const feeStr     = $('#send-fee').val() !== '' ? $('#send-fee').val() : String(globalData.rfee);
        const feeSats    = parseAmountSats(feeStr);
        const minFeeSats = parseAmountSats(String(getConfig()['fee']));
        let outputsSats  = 0;
        let allFilled    = true;
        let allAmtOk     = true;
        let allAddrOk    = true;
        $.each($('#send-outputs .send-outputs-item'), function(_, item) {
            const $addrInput = $('[name="send-address"]', item);
            const address    = $addrInput.val().trim();
            const amtStr     = $('[name="send-amount"]', item).val().trim();
            const amtSats    = parseAmountSats(amtStr);
            const addrOk     = address !== '' && validateAddress(address);
            if (!address || !amtStr) allFilled = false;
            if (!amtSats || amtSats <= 0 || (amtSats > 0 && amtSats < DUST_LIMIT_SATS)) allAmtOk = false;
            if (address !== '' && !addrOk) allAddrOk = false;
            if (amtSats && amtSats > 0) outputsSats += amtSats;
            $addrInput.toggleClass('is-invalid', address !== '' && !addrOk);
        });
        const feeOk     = feeSats !== null && feeSats > 0 && feeSats >= (minFeeSats || 0);
        const totalSats = outputsSats + (feeSats || 0);
        let spendableSats;
        if (globalData.coinControl && globalData.selectedUtxos && globalData.selectedUtxos.size > 0) {
            spendableSats = 0;
            globalData.utxos.forEach(function(u) {
                if (globalData.selectedUtxos.has(u.txid + ':' + u.index) && Number(u.height) > 0 && u.mature)
                    spendableSats += u.value;
            });
        } else {
            spendableSats = 0;
            globalData.utxos.forEach(function(u) {
                if (Number(u.height) > 0 && u.mature) spendableSats += u.value;
            });
        }
        const overLimit = totalSats > spendableSats && totalSats > 0;
        const canSend   = allFilled && allAmtOk && allAddrOk && feeOk && !overLimit && totalSats > 0;
        $('#send-tx').prop('disabled', !canSend);
        $('#wallet-send .wallet-balance').toggleClass('text-danger', overLimit);
        const feeTyped = $('#send-fee').val() !== '';
        $('#send-fee').toggleClass('is-invalid', feeTyped && (!feeOk || overLimit));
        $('#send-outputs [name="send-amount"]').each(function() {
            const amtSats = parseAmountSats($(this).val());
            const typed   = $(this).val() !== '';
            $(this).toggleClass('is-invalid', typed && (!amtSats || amtSats <= 0 || (amtSats > 0 && amtSats < DUST_LIMIT_SATS) || overLimit));
        });
    }
    function showConfirmation(amount, totalSats, feeSats, outputsSats) {
        $('#confirm-amount').text(amount + ' ' + getConfig()['ticker']);
        $('#send-modal-error').addClass('d-none').empty();
        bootstrap.Modal.getOrCreateInstance(document.getElementById('send-modal')).show();
        $('#send-title').text(messages.title['sure']);
        $('#send-cancel').removeClass('disabled d-none');
        $('#send-confirm').removeClass('disabled d-none');
        $('#send-close-footer').addClass('d-none disabled');
        $('#confirm-screen').removeClass('d-none');
        $('#status-screen').addClass('d-none');
        $('#status-screen span').empty();
        globalData.tx.outputs = [];
        $.each($('#send-outputs .send-outputs-item'), function(key, item) {
            const address = $('[name="send-address"]', item).val().trim();
            const amtSats = parseAmountSats($('[name="send-amount"]', item).val());
            globalData.tx.outputs.push({ 'address': address, 'amount': amtSats });
        });
        globalData.tx.amount = totalSats;
        globalData.tx.fee    = feeSats;
    }
    async function getRawTx(txid) {
        const r    = await fetch(getBackend() + '/rawtx/' + txid);
        const data = await r.json();
        if (data.error != null) throw new Error('rawtx fetch failed');
        return data.result;
    }
    function getScriptType(script) {
        if (script[0] == bitcoin.opcodes.OP_0 && script[1] == 20) return 'bech32';
        if (script[0] == bitcoin.opcodes.OP_HASH160 && script[1] == 20) return 'segwit';
        if (script[0] == bitcoin.opcodes.OP_DUP && script[1] == bitcoin.opcodes.OP_HASH160 && script[2] == 20) return 'legacy';
        if (script[0] == 0x51 && script[1] == 32) return 'taproot';   // OP_1 <32-byte x-only pubkey>
        return undefined;
    }
    function getP2SHScript(redeem) {
        return bitcoin.payments.p2sh({ 'redeem': redeem, 'network': getConfig()['network'] });
    }
    function getP2WPKHScript(pubkey) {
        return bitcoin.payments.p2wpkh({ 'pubkey': pubkey, 'network': getConfig()['network'] });
    }
    function validateAddress(address) {
        const network = getConfig()['network'];
        try { const dec = bitcoin.address.fromBase58Check(address); if (dec.version === network.pubKeyHash || dec.version === network.scriptHash) return true; } catch(e) {}
        try { const dec = bitcoin.address.fromBech32(address); if (dec && dec.prefix === network.bech32) return true; } catch(e) {}
        return false;
    }
    function fillMaxAmount($row) {
        const feeStr  = $('#send-fee').val() !== '' ? $('#send-fee').val() : String(globalData.rfee);
        const feeSats = parseAmountSats(feeStr) || parseAmountSats(String(getConfig()['fee'])) || 0;
        let spendableSats = 0;
        if (globalData.coinControl && globalData.selectedUtxos !== null) {
            if (globalData.selectedUtxos.size > 0) {
                globalData.utxos.forEach(function(u) {
                    if (globalData.selectedUtxos.has(u.txid + ':' + u.index) && Number(u.height) > 0 && u.mature)
                        spendableSats += u.value;
                });
            }
        } else {
            globalData.utxos.forEach(function(u) {
                if (Number(u.height) > 0 && u.mature) spendableSats += u.value;
            });
        }
        let otherSats = 0;
        $('#send-outputs .send-outputs-item').each(function() {
            if ($(this).is($row)) return;
            const amt = parseAmountSats($('[name="send-amount"]', this).val());
            if (amt && amt > 0) otherSats += amt;
        });
        const maxSats = Math.max(0, spendableSats - feeSats - otherSats);
        if (maxSats <= 0) return false;
        $row.find('[name="send-amount"]').val(amountFormat(maxSats));
        validateSendForm();
        return true;
    }
    function sendTransaction() {
        if (isSending) return;
        isSending = true;
        const network  = getConfig()['network'];
        const outputs  = globalData.tx.outputs;
        const amount   = globalData.tx.amount;
        const address  = globalData.address;
        const psbt = new bitcoin.Psbt({ network: network });
        psbt.setVersion(2);
        $('#send-cancel').prop('disabled', true).addClass('disabled');
        $('#send-confirm').prop('disabled', true).addClass('disabled');
        $('#confirm-screen').addClass('d-none');
        $('#status-screen').removeClass('d-none');
        $('#send-title').text(messages.title['processing']);
        $('#status-screen .extra-info').empty();
        $('#status-screen span').text(messages.tx['generating']);
        for (let i = 0; i < outputs.length; i++) {
            psbt.addOutput({ address: outputs[i].address, value: BigInt(outputs[i].amount) });
        }
        $('#status-screen span').text(messages.tx['loading-utxo']);
        const doSend = async function(utxos) {
            let spendable;
            if (globalData.coinControl && globalData.selectedUtxos && globalData.selectedUtxos.size > 0) {
                spendable = utxos.filter(function(u) {
                    return globalData.selectedUtxos.has(u.txid + ':' + u.index) && Number(u.height) > 0 && u.mature;
                });
            } else {
                spendable = utxos.filter(function(u) { return Number(u.height) > 0 && u.mature; });
            }
            let value         = 0;
            const inputMeta   = [];
            const pubkey      = globalData.pubKey;
            for (let i = 0; i < spendable.length; i++) {
                const u         = spendable[i];
                const scriptHex = (typeof u.script === 'string' && u.script) ? u.script : globalData.scriptHex;
                const script    = bitcoin.Buffer.from(scriptHex, 'hex');
                const type      = getScriptType(script);
                if (type === 'bech32') {
                    const p2wpkh = getP2WPKHScript(pubkey);
                    psbt.addInput({
                        hash:        u.txid,
                        index:       u.index,
                        witnessUtxo: { script: p2wpkh.output, value: BigInt(u.value) }
                    });
                    inputMeta.push({ type: 'bech32' });
                } else if (type === 'segwit') {
                    const p2wpkh2 = getP2WPKHScript(pubkey);
                    const p2sh2   = getP2SHScript(p2wpkh2);
                    psbt.addInput({
                        hash:         u.txid,
                        index:        u.index,
                        witnessUtxo:  { script: p2sh2.output, value: BigInt(u.value) },
                        redeemScript: p2wpkh2.output
                    });
                    inputMeta.push({ type: 'segwit' });
                } else if (type === 'legacy') {
                    psbt.addInput({ hash: u.txid, index: u.index });
                    inputMeta.push({ type: 'legacy', psbtIdx: inputMeta.length, txid: u.txid });
                } else if (type === 'taproot') {
                    const xOnlyPub = pubkey.length === 33 ? pubkey.slice(1) : pubkey;
                    const p2tr = bitcoin.payments.p2tr({ internalPubkey: xOnlyPub, network: getConfig()['network'] });
                    psbt.addInput({
                        hash:           u.txid,
                        index:          u.index,
                        witnessUtxo:    { script: p2tr.output, value: BigInt(u.value) },
                        tapInternalKey: xOnlyPub
                    });
                    inputMeta.push({ type: 'taproot' });
                } else {
                    showSendError(messages.error['bad-utxo']);
                    return;
                }
                value += u.value;
                if (value >= amount) break;
            }
            if (value < amount) {
                showSendError(messages.error['not-enough-funds']);
                return;
            }
            const legacyFetches = inputMeta
                .filter(function(m) { return m.type === 'legacy'; })
                .map(async function(m) {
                    const rawHex = await getRawTx(m.txid);
                    psbt.updateInput(m.psbtIdx, {
                        nonWitnessUtxo: bitcoin.Buffer.from(rawHex, 'hex')
                    });
                });
            try {
                await Promise.all(legacyFetches);
                const change = value - amount;
                if (change > 0) psbt.addOutput({ address: address, value: BigInt(change) });
                const sendModalInst = bootstrap.Modal.getInstance(document.getElementById('send-modal'));
                if (sendModalInst) sendModalInst.hide();
                const privBytes = await askPrivKeyBytes(
                    getText('pin-title-default'),
                    getText('tx-sign-pin-desc')
                );
                if (!privBytes) {
                    isSending = false;
                    showMessage(escHtml(getText('tx-cancelled')));
                    return;
                }
                Keystore.signAllInputsWithKey(psbt, privBytes);
                psbt.finalizeAllInputs();
                const tx   = psbt.extractTransaction();
                const data = await transactionBroadcast(tx.toHex());
                isSending = false;
                if (data.error == null) {
                    clearUtxoCache(address);
                    $('#status-screen span').html(
                        '<a href="' + escHtml(blockExplorer.tx(data.result)) + '" target="_blank" rel="noopener noreferrer">' + escHtml(data.result) + '</a>'
                    );
                    $('#send-title').text(messages.title['success']);
                } else {
                    $('#status-screen span').text(messages.error['broadcast-failed']);
                    $('#send-title').text(messages.title['failed']);
                    $('#status-screen .extra-info').html(
                        '<div class="mt-3"><textarea class="form-control" readonly cols="30" rows="10">' + escHtml(data.error.message) + '</textarea></div>'
                    );
                }
                bootstrap.Modal.getOrCreateInstance(document.getElementById('send-modal')).show();
                resetTxForm();
                $('#send-cancel').addClass('d-none');
                $('#send-confirm').addClass('d-none');
                $('#send-close-footer').removeClass('d-none disabled');
            } catch(e) {
                isSending = false;
                showSendError(messages.error['bad-utxo']);
            }
        };
        if (globalData.utxos.length > 0) {
            doSend(globalData.utxos);
        } else {
            (async function() {
                try {
                    const r     = await fetch(getBackend() + '/unspent/' + address + '?confirmed=true');
                    const data  = await r.json();
                    const utxos = (data && data.error === null) ? data.result : [];
                    const h     = globalData.height;
                    utxos.forEach(function(u) {
                        u.mature     = isUtxoMature(u, h);
                        u.blocksLeft = blocksToMature(u, h);
                    });
                    globalData.utxos = utxos;
                    doSend(utxos);
                } catch(e) {
                    isSending = false;
                    showSendError(messages.error['not-enough-utxo']);
                }
            })();
        }
    }
    function transactionBroadcast(rawtx) {
        return Promise.resolve($.ajax({
            'method': 'POST',
            'url':    getBackend() + '/broadcast',
            'data':   { 'raw': rawtx }
        }));
    }
    function estimateFee() {
        return Promise.resolve($.ajax({ 'url': getBackend() + '/fee' }));
    }
    function resetTxForm() {
        isSending = false;
        $('.send-additional-output').remove();
        $('#wallet-send input').val('');
        $('#wallet-send .wallet-balance').removeClass('text-danger');
        $('#send-fee, #send-outputs [name="send-amount"]').removeClass('is-invalid');
        $('#send-cancel').prop('disabled', false);
        $('#send-confirm').prop('disabled', false);
        globalData.resetTx();
        validateSendForm();
    }
    function hasSavedWallet() {
        return localStorage.getItem(STORAGE_KEY_PRIV) !== null;
    }
    function forgetSavedWallet() {
        stopAutoLock();
        stopStream();
        wsDisconnect();
        [STORAGE_KEY_PUB, STORAGE_KEY_PRIV, STORAGE_KEY_SEED, STORAGE_KEY_PATH,
         STORAGE_KEY_PRIV_PK, STORAGE_KEY_SEED_PK, STORAGE_KEY_PK_ID].forEach(function(k) {
            try { localStorage.removeItem(k); } catch(e) {}
        });
        try {
            Object.keys(localStorage).forEach(function(k) {
                if (k.indexOf('bte_history_') === 0 || k.indexOf('bte_utxo_') === 0 || k.indexOf('bte_wallet_') === 0) {
                    localStorage.removeItem(k);
                }
            });
        } catch(e) {}
        clearSensitiveInputs();
        clearSeedState();
        Keystore.clear();
        globalData.clear();
        clearPrivKeyCanvas();
        $('#wallet-keys-pubkey input').val('');
        $('#wallet-keys-script input').val('');
        $('#wallet-address').text('');
        $('#qr-code-address').empty();
        resetTxForm();
        hideSeedReveal();
        $('#wallet-block').addClass('d-none');
        updateSavedWalletUI();
        setHomeTitle();
        window.location.reload(true);
    }
    function updateSavedWalletUI() {
        if (hasSavedWallet() && !Keystore.isUnlocked()) {
            $('#pin-login-block').removeClass('d-none');
            $('#open-block').addClass('d-none');
            $('#forget-wallet-section').removeClass('d-none');
        } else if (!hasSavedWallet()) {
            $('#pin-login-block').addClass('d-none');
            $('#open-block').removeClass('d-none');
            $('#forget-wallet-section').addClass('d-none');
        } else {
            $('#pin-login-block').addClass('d-none');
            $('#open-block').addClass('d-none');
        }
    }
    function showWalletUI() {
        const pubBytes = globalData.pubKey;
        let pubkeyDisplay = '';
        if (pubBytes) {
            for (let i = 0; i < pubBytes.length; i++) pubkeyDisplay += pubBytes[i].toString(16).padStart(2, '0');
        }
        const addressType = getAddressType();
        let redeem = '';
        if (addressType !== 'legacy') {
            redeem = '0014' + bitcoin.Buffer.from(
                bitcoin.payments.p2wpkh({ pubkey: globalData.pubKey, network: getConfig()['network'] }).hash
            ).toString('hex');
        }
        $('#wallet-keys-pubkey input').val(pubkeyDisplay);
        clearPrivKeyCanvas();
        $('#wallet-keys-script input').val(redeem);
        if (addressType === 'legacy') {
            $('#wallet-keys-script').addClass('d-none');
        } else {
            $('#wallet-keys-script').removeClass('d-none');
        }
        if (hasSeedBackup()) {
            $('#wallet-keys-seed').removeClass('d-none');
        } else {
            $('#wallet-keys-seed').addClass('d-none');
        }
        hideSeedReveal();
        $('#wallet-address').text(globalData.address);
        $('#pin-login-block').addClass('d-none');
        $('#open-block').addClass('d-none');
        $('#wallet-block').removeClass('d-none');
        $('#send-fee').attr('placeholder', getText('fee') + ' (' + getText('recommended') + ' ' + globalData.rfee + ' ' + getConfig()['ticker'] + ')');
        showQrAddress(getConfig()['uri'] + globalData.address);
        TxHistory.renderHistory(TxHistory.loadHistory());
        const cached = loadUtxoCache(globalData.address);
        if (cached && Array.isArray(cached.utxos)) {
            const ch = cached.height || 0;
            globalData.height  = ch;
            globalData.utxos   = cached.utxos.map(function(u) {
                return Object.assign({}, u, {
                    mature:     isUtxoMature(u, ch),
                    blocksLeft: blocksToMature(u, ch)
                });
            });
            globalData.balance    = cached.balance || 0;
            globalData.pendingOut = cached.pendingOut || 0;
        } else {
            globalData.balance         = 0;
            globalData.immatureBalance = 0;
            globalData.pendingOut      = 0;
            globalData.utxos           = [];
        }
        applyUtxoData();
        if (ws && wsActive) {
            ws.emit('subscribe', { address: globalData.address });
        }
    }
    async function openWallet(offerPin, bip39Entropy, derivPath, isRestore) {
        if (offerPin && !hasSavedWallet()) {
            let pin = await askPinSetup();
            if (pin === null) {
                Keystore.clear();
                globalData.clear();
                clearSensitiveInputs();
                resetTxForm();
                clearPrivKeyCanvas();
                hideSeedReveal();
                if (bip39Entropy && !isRestore) {
                    bip39Entropy.fill(0);
                    seedReset();
                    showMessage(escHtml(getText('seed-pin-cancel')));
                }
                return;
            }
            globalData.pubKey = new Uint8Array(Keystore.getPublicKeyBytes());
            if (bip39Entropy) {
                await saveWalletBip39(bip39Entropy, pin, derivPath);
            } else {
                await saveWalletWif(pin);
            }
            pin = null;
            Keystore.clearTempKeyPair();
            showMessage(escHtml(getText('wallet-saved')));
            updateSavedWalletUI();
        }
        if (bip39Entropy) { bip39Entropy.fill(0); bip39Entropy = null; }
        globalData.status         = 'unlocked';
        globalData.address        = Keystore.deriveAddress(getAddressType(), globalData.pubKey);
        globalData.scriptHex      = Keystore.getScriptHex(getAddressType(), globalData.pubKey);
        globalData.allScriptHexes = Keystore.getAllScriptHexes(globalData.pubKey);
        globalData.allAddresses   = Keystore.getAllAddresses(globalData.pubKey);
        showWalletUI();
        wsConnect();
        setHomeTitle();
        resetAutoLock();
    }
    function entropyToIndices(entropyBytes) {
        const hash     = bitcoin.crypto.sha256(entropyBytes);
        const ENT      = entropyBytes.length * 8;
        const CS       = ENT / 32;
        const wordCount = (ENT + CS) / 11;
        let bits = BigInt(0);
        for (let i = 0; i < entropyBytes.length; i++) {
            bits = (bits << 8n) | BigInt(entropyBytes[i]);
        }
        bits = (bits << BigInt(CS)) | (BigInt(hash[0]) >> BigInt(8 - CS));
        const indices = new Array(wordCount);
        for (let i = wordCount - 1; i >= 0; i--) {
            indices[i] = Number(bits & 0x7FFn);
            bits >>= 11n;
        }
        return indices;
    }
    function closeWallet() {
        stopAutoLock();
        stopStream();
        wsDisconnect();
        clearPrivKeyCanvas();
        $('#wallet-keys-pubkey input').val('');
        $('#wallet-keys-script input').val('');
        $('#wallet-address').text('');
        $('#qr-code-address').empty();
        resetTxForm();
        hideSeedReveal();
        clearSensitiveInputs();
        clearSeedState();
        Keystore.clear();
        globalData.clear();
        $('#wallet-block').addClass('d-none');
        updateSavedWalletUI();
        setHomeTitle();
        window.location.reload(true);
    }
    function revealSeedFromBytes(entropyBytes) {
        seedStore.setPending(entropyBytes); // take ownership
        const indices  = entropyToIndices(entropyBytes);
        const wordlist = bip39Bundle.wordlist;
        const words    = indices.map(function(i) { return wordlist[i]; });
        seedRenderGrid(words, '#wallet-seed-grid');
        words.fill('');
        indices.fill(0);
        $('#wallet-seed-hidden').addClass('d-none');
        $('#wallet-seed-revealed').removeClass('d-none');
        setTimeout(hideSeedReveal, 60000);
    }
    function hideSeedReveal() {
        seedStore.wipePending();
        $('#wallet-seed-hidden').removeClass('d-none');
        $('#wallet-seed-revealed').addClass('d-none');
        $('#wallet-seed-grid').empty();
    }
    function seedRenderGrid(words, containerId) {
        const $g      = $(containerId).empty();
        const cs       = getComputedStyle(document.body);
        const bgColor  = cs.getPropertyValue('--bs-body-bg').trim()        || '#f8f9fa';
        const numColor = cs.getPropertyValue('--bs-secondary-color').trim() || '#6c757d';
        const txtColor = cs.getPropertyValue('--bs-body-color').trim()     || '#212529';
        words.forEach(function(w, i) {
            const canvas = document.createElement('canvas');
            canvas.width = 110; canvas.height = 42;
            canvas.setAttribute('aria-hidden', 'true');
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, 110, 42);
            ctx.fillStyle = numColor;
            ctx.font = '10px sans-serif';
            ctx.fillText(i + 1, 5, 12);
            ctx.fillStyle = txtColor;
            ctx.font = 'bold 13px monospace';
            ctx.fillText(w, 5, 31);
            const $cell = $('<div class="border rounded px-1 py-1 text-center seed-canvas-cell"></div>');
            $cell.append(canvas);
            $g.append($cell);
        });
    }
    function seedReset() {
        $('#seed-entry').removeClass('d-none');
        $('#seed-create').addClass('d-none');
        $('#seed-restore').addClass('d-none');
        $('#seed-create-step1').removeClass('d-none');
        $('#seed-create-step2').addClass('d-none');
        $('#seed-word-grid').empty();
        $('#seed-generate-warning, #seed-verify-error').addClass('d-none');
        $('#seed-verify-fields').empty();
        $('#seed-btn-to-verify').prop('disabled', false);
        $('#seed-verify-confirm').prop('disabled', false);
        clearSensitiveInputs();
        $('#restore-word-error').addClass('d-none');
        $('#restore-path').val(DEFAULT_DERIV_PATH);
        $('#restore-advanced').removeClass('show');
        clearSeedState();
    }
    function routePage() {
        const urlParams = readParams();
        if (window.location.hash === '') {
            window.location.replace(window.location.href.split('#')[0] + '#/');
        }
        if (urlParams[0] !== '#') return;
        const pageName     = urlParams[1] || 'homepage';
        const templateName = '#' + pageName;
        $('.router-link').removeClass('active');
        $('.router-link[data-route=' + pageName + ']').addClass('active');
        if ($('.router-page:visible').attr('id') !== urlParams[1]) {
            $('div.router-page').hide();
            if ($(templateName).length) $(templateName).show();
        }
        switch (pageName) {
            case 'homepage':
                setHomeTitle();
                break;
            case 'broadcast':
                setTitle(getText('broadcast-transaction'));
                break;
            case 'network': {
                const network = urlParams[2];
                if (network !== undefined) switchConfig(network);
                break;
            }
            default:
                switchPage();
        }
    }
    function switchPage(url, params) {
        url    = url    || '';
        params = params || [];
        const p = params.length > 0 ? '/' + params.join('/') : '';
        window.location.hash = '#/' + url + p;
    }
    function readParams() { return window.location.hash.split('/'); }
    function setTitle(title) { document.title = title + ' | ' + getConfig()['title']; }
    function stopStream() {
        scanSession += 1;
        if (scanRafId !== null) {
            cancelAnimationFrame(scanRafId);
            scanRafId = null;
        }
        if (scanVideo) {
            try { scanVideo.pause(); } catch(e) {}
            try { scanVideo.srcObject = null; } catch(e) {}
            scanVideo = null;
        }
        if (stream != null) {
            try { stream.getTracks().forEach(function(t) { t.stop(); }); } catch(e) {}
            stream = null;
        }
        const canvasElement = document.getElementById('scan-canvas');
        if (canvasElement) {
            try {
                const ctx = canvasElement.getContext('2d');
                if (ctx) ctx.clearRect(0, 0, canvasElement.width || 0, canvasElement.height || 0);
            } catch(e) {}
            canvasElement.hidden = true;
            canvasElement.width = 0;
            canvasElement.height = 0;
        }
    }
    function startStream() {
        const canvasElement = document.getElementById('scan-canvas');
        const ctx     = canvasElement.getContext('2d');
        const video   = document.createElement('video');
        const session = ++scanSession;
        canvasElement.hidden = true;
        $('#loading-message').text(getText('webcam-message')).removeClass('d-none');
        stopStream();
        scanSession = session;
        scanVideo   = video;
        (async function() {
            try {
                const gstream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
                if (session !== scanSession) {
                    try { gstream.getTracks().forEach(function(t) { t.stop(); }); } catch(e) {}
                    return;
                }
                stream    = gstream;
                scanVideo = video;
                video.srcObject = stream;
                video.setAttribute('playsinline', true);
                video.play();
                scanRafId = requestAnimationFrame(tick);
            } catch(e) {
                if (session !== scanSession) return;
                stopStream();
                $('#loading-message').text(getText('webcam-message')).removeClass('d-none');
                showMessage(escHtml(getText('webcam-message')));
            }
        })();
        function tick() {
            if (session !== scanSession) return;
            $('#loading-message').text(getText('webcam-loading'));
            let stop = false;
            if (video.readyState === video.HAVE_ENOUGH_DATA) {
                $('#loading-message').addClass('d-none');
                canvasElement.hidden = false;
                canvasElement.height = video.videoHeight;
                canvasElement.width  = video.videoWidth;
                ctx.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);
                const imageData = ctx.getImageData(0, 0, canvasElement.width, canvasElement.height);
                const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
                if (code) {
                    let address = code.data;
                    if (address.startsWith(getConfig()['uri'])) address = address.replace(getConfig()['uri'], '');
                    if (validateAddress(address)) {
                        if ($('#send-outputs input[name="send-address"]').last().val() != '') $('#add-output').click();
                        $('#send-outputs input[name="send-address"]').last().val(address);
                        showMessage(messages.misc.outputAdded(address));
                        stop = true;
                    }
                }
            }
            if (!stop) {
                scanRafId = requestAnimationFrame(tick);
            } else {
                bootstrap.Modal.getInstance(document.getElementById('scan-modal')).hide(); stopStream();
            }
        }
    }
    function showScanModal() {
        bootstrap.Modal.getOrCreateInstance(document.getElementById('scan-modal')).toggle();
        startStream();
    }
    $(document).ready(function() {
        initLang();
        $(document).on('click', '.theme-option', function(e) {
            e.preventDefault();
            const theme = $(this).data('theme');
            if (theme) setTheme(theme);
        });
        let t; try { t = localStorage.getItem('bte_cfg_theme'); } catch(e) {}
        applyTheme(t || 'auto');
        ;['click', 'keydown', 'touchstart', 'mousemove'].forEach(function(evt) {
            document.addEventListener(evt, function() { resetAutoLock(); }, { passive: true, capture: false });
        });
        $('#wallet-version').text(walletVersion);
        $('#wallet-backend input').val(getBackend());
        $('#address-type-select select').val(getAddressType());
        routePage();
        updateSavedWalletUI();
        $('#pin-confirm').click(async function() {
            const $btn = $(this);
            if ($btn.prop('disabled')) return;
            let pin = $('#pin-input').val();
            if (pinResolve) {
                if (pinValidator) {
                    $btn.prop('disabled', true);
                    const err = await pinValidator(pin);
                    $btn.prop('disabled', false);
                    if (err) {
                        $('#pin-error').text(err).removeClass('d-none');
                        $('#pin-input').focus();
                        return;
                    }
                }
                $('#pin-error').addClass('d-none');
                let pinValue = pin;
                pin = null;
                $('#pin-input').val('');
                pinPasskeyCallback = null;
                $('#pin-modal-pk-btn').addClass('d-none');
                const resolve = pinResolve;
                pinResolve   = null;
                pinValidator = null;
                const modalEl = document.getElementById('pin-modal');
                function onHidden() {
                    modalEl.removeEventListener('hidden.bs.modal', onHidden);
                    resolve(pinValue);
                    pinValue = null;
                }
                modalEl.addEventListener('hidden.bs.modal', onHidden);
                bootstrap.Modal.getInstance(modalEl).hide();
            }
        });
        $('#pin-cancel').click(function() {
            $('#pin-input').val('');
            pinPasskeyCallback = null;
            $('#pin-modal-pk-btn').addClass('d-none');
            if (pinResolve) {
                const resolve = pinResolve;
                pinResolve   = null;
                pinValidator = null;
                const modalEl = document.getElementById('pin-modal');
                function onHidden() {
                    modalEl.removeEventListener('hidden.bs.modal', onHidden);
                    resolve(null);
                }
                modalEl.addEventListener('hidden.bs.modal', onHidden);
                const inst = bootstrap.Modal.getInstance(modalEl);
                if (inst) inst.hide();
            }
        });
        $('#pin-modal-pk-btn').click(function() {
            const cb = pinPasskeyCallback;
            pinPasskeyCallback = null;
            $('#pin-modal-pk-btn').addClass('d-none');
            $('#pin-input').val('');
            if (pinResolve) {
                const resolve = pinResolve;
                pinResolve   = null;
                pinValidator = null;
                const modalEl = document.getElementById('pin-modal');
                function onHidden() {
                    modalEl.removeEventListener('hidden.bs.modal', onHidden);
                    if (cb) {
                        cb();
                    } else {
                        resolve(null);
                    }
                }
                modalEl.addEventListener('hidden.bs.modal', onHidden);
                const inst = bootstrap.Modal.getInstance(modalEl);
                if (inst) inst.hide();
            }
        });
        $('#pin-input').on('keydown', function(e) {
            if (e.key === 'Enter') $('#pin-confirm').click();
        });
        $(document).on('keyup keydown', '#pin-input', function(e) {
            const capsOn = (e.originalEvent && e.originalEvent.getModifierState)
                ? e.originalEvent.getModifierState('CapsLock')
                : false;
            if (capsOn) { $('#pin-caps-warning').removeClass('d-none'); }
            else        { $('#pin-caps-warning').addClass('d-none'); }
        });
        async function doUnlock() {
            $('#pin-login-btn').prop('disabled', true).text(getText('loading'));
            await new Promise(function(r) { setTimeout(r, 30); });
            try {
                const pubBytes = loadPublicKeyPlain();
                if (!pubBytes) {
                    $('#pin-login-btn').prop('disabled', false).text(getText('pin-login-btn'));
                    showMessage(escHtml(getText('pin-login-error')));
                    return;
                }
                Keystore.setPubOnly(pubBytes);
                globalData.pubKey = pubBytes;
                await openWallet(false);
            } catch(e) {
                $('#pin-login-btn').prop('disabled', false).text(getText('pin-login-btn'));
                showMessage(escHtml(getText('pin-login-error')));
            }
        }
        $('#pin-login-btn').click(doUnlock);
        $('#pin-login-block').on('keydown', function(e) { if (e.key === 'Enter') doUnlock(); });
        $(document).on('click', '#passkey-settings-btn', async function(e) {
            e.preventDefault();
            if (isPasskeyEnabled()) {
                pkDisable();
            } else {
                const supported = await checkPasskeySupport();
                if (!supported) {
                    showMessage(escHtml(getText('passkey-unsupported')));
                    return;
                }
                pkEnable();
            }
        });
        function showForgetWalletModal() {
            const $input  = $('#forget-wallet-confirm-input');
            const $yesBtn = $('#forget-wallet-modal-yes');
            $input.val('');
            $yesBtn.prop('disabled', true);
            bootstrap.Modal.getOrCreateInstance(document.getElementById('forget-wallet-modal'), {
                backdrop: 'static', keyboard: false
            }).show();
        }
        $('#forget-wallet-confirm-input').on('input', function() {
            const val = $(this).val().trim();
            $('#forget-wallet-modal-yes').prop('disabled', val !== 'Yes');
        });
        $('#forget-wallet-modal-yes').click(function() {
            bootstrap.Modal.getInstance(document.getElementById('forget-wallet-modal')).hide();
            forgetSavedWallet();
        });
        $('#pin-login-forget').click(function(e) {
            e.preventDefault();
            showForgetWalletModal();
        });
        $('#settings-forget-wallet').click(function() {
            showForgetWalletModal();
        });
        $(document).on('click', '.tab-link', function(e) {
            e.preventDefault();
            const tabFamily = $(this).data('tab-family');
            const tabName   = $(this).data('tab-name');
            if (tabFamily === 'wallet-block' && tabName !== 'wallet-keys') {
                clearPrivKeyCanvas();
                hideSeedReveal();
            }
            $('#' + tabFamily + ' .tab-item').addClass('d-none');
            $('#' + tabFamily + ' .card-header .card-header-tabs .nav-link').removeClass('active');
            $('#' + tabFamily + ' [data-tab=' + tabName + ']').removeClass('d-none');
            $(this).addClass('active');
            if (tabName === 'wallet-history') TxHistory.updateHistory();
            if (tabName === 'wallet-settings') {
                $('#address-type-select select').val(getAddressType());
                $('#wallet-backend input').val(getBackend());
                if (hasSavedWallet()) {
                    $('#forget-wallet-section').removeClass('d-none');
                } else {
                    $('#forget-wallet-section').addClass('d-none');
                }
                updatePasskeySettingsUI();
            }
        });
        $(window).on('hashchange', routePage);
        if (window.location.hash) $(window).trigger('hashchange');
        $('#send-tx').click(function() {
            let error       = false;
            const feeStr    = $('#send-fee').val() !== '' ? $('#send-fee').val() : String(globalData.rfee);
            const feeSats   = parseAmountSats(feeStr);
            const minFeeSats = parseAmountSats(String(getConfig()['fee']));
            if (feeSats === null || feeSats <= 0) {
                showSendError(messages.error['not-valid-fee']); error = true;
            } else if (feeSats < minFeeSats) {
                showSendError(messages.error['small-fee']); error = true;
            }
            let outputsSats = 0;
            $.each($('#send-outputs .send-outputs-item'), function(key, item) {
                const address = $('[name="send-address"]', item).val().trim();
                const amtStr  = $('[name="send-amount"]', item).val();
                const amtSats = parseAmountSats(amtStr);
                if (amtSats === null || amtSats <= 0) {
                    showSendError(messages.error['not-valid-amount']); error = true;
                }
                if (!validateAddress(address)) {
                    showSendError(messages.error['not-valid-address']); error = true;
                }
                if (amtSats !== null) outputsSats += amtSats;
            });
            const totalSats = outputsSats + (feeSats || 0);
            let spendableSats;
            if (globalData.coinControl && globalData.selectedUtxos && globalData.selectedUtxos.size > 0) {
                spendableSats = 0;
                globalData.utxos.forEach(function(u) {
                    if (globalData.selectedUtxos.has(u.txid + ':' + u.index) && Number(u.height) > 0 && u.mature) {
                        spendableSats += u.value;
                    }
                });
            } else {
                spendableSats = 0;
                globalData.utxos.forEach(function(u) {
                    if (Number(u.height) > 0 && u.mature) spendableSats += u.value;
                });
            }
            if (!error) {
                if (totalSats <= spendableSats) {
                    showConfirmation(amountFormat(totalSats), totalSats, feeSats, outputsSats);
                } else {
                    showSendError(messages.error['not-enough-funds']);
                }
            }
        });
        $('#send-fee').on('input', function() {
            const cur = filterAmountStr($(this).val(), getConfig()['decimals']);
            if (cur !== $(this).val()) $(this).val(cur);
            validateSendForm();
        });
        $('#send-outputs').on('input', '[name="send-amount"]', function() {
            const cur = filterAmountStr($(this).val(), getConfig()['decimals']);
            if (cur !== $(this).val()) $(this).val(cur);
            validateSendForm();
        });
        $('#send-outputs').on('input', '[name="send-address"]', function() {
            validateSendForm();
        });
        $(document).on('paste', '#send-fee, [name="send-amount"]', function() {
            const self = this;
            setTimeout(function() {
                const cur = filterAmountStr($(self).val(), getConfig()['decimals']);
                if (cur !== $(self).val()) $(self).val(cur);
                validateSendForm();
            }, 0);
        });
        $('#send-confirm').click(function(e) { sendTransaction(); e.preventDefault(); });
        document.getElementById('send-modal').addEventListener('hidden.bs.modal', function() {
            isSending = false;
            $('#send-cancel').prop('disabled', false);
            $('#send-confirm').prop('disabled', false);
        });
        $('#open-key-form').submit(async function(e) {
            e.preventDefault();
            let wif = $('#passphrase').val().trim();
            if ([51, 52].includes(wif.length)) {
                try {
                    Keystore.setTempKeyPair(bitcoin.ECPair.fromWIF(wif, getConfig()['network']));
                    $('#passphrase').val('');
                    await openWallet(true);
                } catch(err) {
                    showMessage(messages.error['bad-priv-key']);
                } finally {
                    wif = null;
                }
            } else {
                showMessage(messages.error['bad-priv-key']);
                wif = null;
            }
        });
        $('#open-regular-form').submit(async function(e) {
            e.preventDefault();
            const identity  = $('#open-email').val().trim();
            let pass        = $('#open-password').val();
            let passConfirm = $('#open-password-confirm').val();
            if (identity.length >= 3) {
                if (pass.length >= 10) {
                    if (pass == passConfirm) {
                        let s = identity.toLowerCase();
                        s += '|' + pass + '|';
                        s += s.length + '|!@' + ((pass.length * 7) + identity.length) * 7;
                        const regchars   = (pass.match(/[a-z]+/g)) ? pass.match(/[a-z]+/g).length   : 1;
                        const regupchars = (pass.match(/[A-Z]+/g)) ? pass.match(/[A-Z]+/g).length   : 1;
                        const regnums    = (pass.match(/[0-9]+/g)) ? pass.match(/[0-9]+/g).length   : 1;
                        s += ((regnums + regchars) + regupchars) * pass.length + '3571';
                        s += (s + '' + s);
                        for (let i = 0; i <= 50; i++) s = sha256(s);
                        const privBytes = new Uint8Array(bitcoin.Buffer.from(sha256(s), 'hex'));
                        s = '';
                        $('#open-email').val('');
                        $('#open-password').val('');
                        $('#open-password-confirm').val('');
                        Keystore.setTempKeyPair(bitcoin.ECPair.fromPrivateKey(
                            bitcoin.Buffer.from(privBytes),
                            { 'network': getConfig()['network'] }
                        ));
                        privBytes.fill(0);
                        pass = '';
                        passConfirm = '';
                        await openWallet(true);
                    } else { showMessage(messages.error['pass-not-match']); pass = ''; passConfirm = ''; }
                } else { showMessage(messages.error['pass-too-short']); pass = ''; passConfirm = ''; }
            } else { showMessage(escHtml(getText('identity-too-short'))); pass = ''; passConfirm = ''; }
        });
        $('#toggle-wallet-privkey').click(async function() {
            if (!Keystore.isUnlocked()) return;
            const privBytes = await askPrivKeyBytes(
                getText('pin-title-default'),
                getText('privkey-pin-desc')
            );
            if (!privBytes) return;
            revealPrivKeyCanvas(privBytes); // wipes privBytes
            setTimeout(function() { clearPrivKeyCanvas(); }, 60000);
        });
        $('#privkey-hide-btn').click(function() {
            clearPrivKeyCanvas();
        });
        $('#wallet-privkey-copy-btn').click(async function() {
            if (!Keystore.isUnlocked()) return;
            const $btn = $(this);
            if (revealedWif) {
                const wifCopy = revealedWif;
                doPrivKeyCopy($btn, wifCopy);
                return;
            }
            async function doPrivKeyCopy($b, wif) {
                const doFeedback = function(ok) {
                    const $icon    = $b.find('.fa-solid, .fa-regular').first();
                    const origClass = $icon.attr('class');
                    if ($icon.length) $icon.attr('class', 'fa-solid ' + (ok ? 'fa-check' : 'fa-times'));
                    $b.addClass(ok ? 'btn-success' : 'btn-danger').removeClass('btn-outline-secondary');
                    setTimeout(function() {
                        if ($icon.length) $icon.attr('class', origClass);
                        $b.removeClass('btn-success btn-danger').addClass('btn-outline-secondary');
                    }, 1500);
                };
                try {
                    await navigator.clipboard.writeText(wif);
                    doFeedback(true);
                    setTimeout(function() { navigator.clipboard.writeText('').catch(function(){}); }, 60000);
                } catch(e) {
                    doFeedback(false);
                }
            }
            const privBytes = await askPrivKeyBytes(
                getText('pin-title-default'),
                getText('privkey-pin-desc')
            );
            if (!privBytes) return;
            const kp = bitcoin.ECPair.fromPrivateKey(
                bitcoin.Buffer.from(privBytes), { network: getConfig()['network'] }
            );
            privBytes.fill(0);
            let wif = kp.toWIF();
            destroyKeyMaterial(kp);
            await doPrivKeyCopy($btn, wif);
            wif = null;
        });
        $('#add-output').click(function(e) {
            $('#send-outputs').append(
                '<div class="send-additional-output send-outputs-item mb-2">' +
                '<input name="send-address" class="form-control mb-1" placeholder="' + escHtml(getText('enter-address')) + '" type="text" autocomplete="off">' +
                '<div class="input-group">' +
                '<input name="send-amount" class="form-control" placeholder="' + escHtml(getText('amount')) + '" type="text" autocomplete="off">' +
                '<button class="send-max btn btn-outline-secondary" type="button">MAX</button>' +
                '<button class="btn btn-outline-danger remove-additional-output" type="button"><span class="fa-solid fa-minus"></span></button>' +
                '</div>' +
                '</div>'
            );
            $('.remove-additional-output').off('click').on('click', function(e) {
                $(this).closest('.send-additional-output').remove();
                validateSendForm();
                e.preventDefault();
            });
            validateSendForm();
            e.preventDefault();
        });
        $(document).on('click', '.send-max', function(e) {
            e.preventDefault();
            if (globalData.status !== 'unlocked') return;
            const filled = fillMaxAmount($(this).closest('.send-outputs-item'));
            if (!filled) showMessage(escHtml(getText('not-enough-funds')));
        });
        $('#send-reset').click(function(e) { resetTxForm(); e.preventDefault(); });
        $('#send-qr').click(function(e)    { showScanModal(); e.preventDefault(); });
        $('#footer-close').click(function(e) { closeWallet(); e.preventDefault(); });
        $('#coin-control-toggle').click(function(e) {
            $('#coin-control-panel').toggleClass('d-none');
            const open = !$('#coin-control-panel').hasClass('d-none');
            $('#coin-control-toggle-text').text(open ? getText('coin-control') + ' ▲' : getText('coin-control'));
            if (open) renderCoinControl();
            e.preventDefault();
        });
        $(document).on('change', '#coin-control-enable', function() {
            globalData.coinControl = $(this).is(':checked');
            if (globalData.coinControl) {
                globalData.selectedUtxos = new Set();
                globalData.utxos.forEach(function(u) {
                    if (Number(u.height) > 0 && u.mature) globalData.selectedUtxos.add(u.txid + ':' + u.index);
                });
            } else {
                globalData.selectedUtxos = null;
            }
            renderCoinControl();
            validateSendForm();
        });
        $('#coin-control-select-all').click(function(e) {
            if (!globalData.coinControl) return e.preventDefault();
            globalData.selectedUtxos = new Set();
            globalData.utxos.forEach(function(u) {
                if (Number(u.height) > 0 && u.mature) globalData.selectedUtxos.add(u.txid + ':' + u.index);
            });
            renderCoinControl();
            validateSendForm();
            e.preventDefault();
        });
        $('#coin-control-deselect-all').click(function(e) {
            if (!globalData.coinControl) return e.preventDefault();
            globalData.selectedUtxos = new Set();
            renderCoinControl();
            validateSendForm();
            e.preventDefault();
        });
        $(document).on('click', '.cc-sort-th', function() {
            const col = $(this).data('sort');
            if (ccSort.col === col) {
                ccSort.dir = ccSort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                ccSort.col = col;
                ccSort.dir = col === 'amount' ? 'desc' : 'asc';
            }
            saveCcSort();
            renderCoinControl();
        });
        $(document).on('change', '.cc-utxo-check', function() {
            if (!globalData.coinControl || !globalData.selectedUtxos) return;
            const key = $(this).data('key');
            if ($(this).is(':checked')) globalData.selectedUtxos.add(key);
            else globalData.selectedUtxos.delete(key);
            updateCoinControlInfo();
            validateSendForm();
        });
        $('#footer-broadcast').click(async function() {
            const rawtx  = $('#transaction-broadcast-raw');
            const rawHex = rawtx.val();
            rawtx.val('');
            const data = await transactionBroadcast(rawHex);
            if (data.error == null) {
                showMessage(escHtml(messages.tx['success']) + '<a href="' + escHtml(blockExplorer.tx(data.result)) + '" target="_blank" rel="noopener noreferrer">' + escHtml(data.result) + '</a>');
            } else {
                showMessage(messages.error['broadcast-failed']);
            }
        });
        $('#address-type-select select').on('change', function() {
            const newType = $(this).val();
            switchAddressType(newType);
            showMessage(messages.settings.typeSwitched(newType));
            if (!Keystore.isUnlocked()) return;
            if (globalData.address) clearUtxoCache(globalData.address);
            globalData.utxos              = [];
            globalData.coinControl        = false;
            globalData.selectedUtxos      = null;
            globalData.immatureBalance    = 0;
            globalData.unconfirmedBalance = 0;
            globalData.pendingOut         = 0;
            globalData.lastRendered      = { balance: -1, immature: -1, unconfirmed: -1, pendingOut: -1, utxoFingerprint: '' };
            globalData.address        = Keystore.deriveAddress(newType, globalData.pubKey);
            globalData.scriptHex      = Keystore.getScriptHex(newType, globalData.pubKey);
            globalData.allScriptHexes = Keystore.getAllScriptHexes(globalData.pubKey);
            globalData.allAddresses   = Keystore.getAllAddresses(globalData.pubKey);
            if (ws && wsActive) {
                ws.emit('subscribe', { address: globalData.address });
            }
            $('#wallet-address').text(globalData.address);
            showQrAddress(getConfig()['uri'] + globalData.address);
            const pb = globalData.pubKey;
            let phex = '';
            if (pb) { for (let j = 0; j < pb.length; j++) phex += pb[j].toString(16).padStart(2, '0'); }
            $('#wallet-keys-pubkey input').val(phex);
            clearPrivKeyCanvas();
            let redeem = '';
            if (newType !== 'legacy') {
                redeem = '0014' + bitcoin.Buffer.from(
                    bitcoin.payments.p2wpkh({ pubkey: globalData.pubKey, network: getConfig()['network'] }).hash
                ).toString('hex');
            }
            $('#wallet-keys-script input').val(redeem);
            if (newType === 'legacy') {
                $('#wallet-keys-script').addClass('d-none');
            } else {
                $('#wallet-keys-script').removeClass('d-none');
            }
            setHomeTitle();
        });
        $('#wallet-backend button').click(function() {
            switchBackend($('#wallet-backend input').val());
        });
        $(document).on('click', '.lang-switch-item', function(e) {
            e.preventDefault();
            const lang = $(this).data('lang');
            try { localStorage.setItem('bte_cfg_language', lang); } catch(e) {}
            initLang();
            let ct; try { ct = localStorage.getItem('bte_cfg_theme'); } catch(e) {}
            applyTheme(ct || 'auto');
            $('#address-type-select select').val(getAddressType());
            updatePasskeySettingsUI();
            if (globalData.status === 'unlocked') {
                $('#send-fee').attr('placeholder',
                    getText('fee') + ' (' + getText('recommended') + ' ' + globalData.rfee + ' ' + getConfig()['ticker'] + ')'
                );
            }
        });
        (async function() {
            const data = await estimateFee();
            if (data.error == null) globalData.rfee = amountFormat(data.result.feerate);
            else globalData.rfee = getConfig()['fee'];
        })();
        document.getElementById('scan-modal').addEventListener('hide.bs.modal', function() { stopStream(); });
        $(window).on('beforeunload', stopStream);
        $('#copy-address-btn').click(function() {
            if (globalData.address) copyToClipboard(globalData.address, $(this));
        });
        $('#seed-btn-create').click(function() {
            $('#seed-entry').addClass('d-none');
            $('#seed-create').removeClass('d-none');
            seedDoGenerate();
        });
        $('#seed-btn-restore').click(function() {
            $('#seed-entry').addClass('d-none');
            $('#seed-restore').removeClass('d-none');
        });
        $('#seed-create-cancel1, #seed-create-cancel2, #seed-restore-cancel').click(function(e) {
            e.preventDefault();
            seedReset();
        });
        $(document).on('click', '.seed-wlen-btn', function() {
            $('.seed-wlen-btn').removeClass('active');
            $(this).addClass('active');
            seedStore.strength = parseInt($(this).data('len'), 10);
            seedDoGenerate();
        });
        function seedDoGenerate() {
            if (typeof bip39Bundle === 'undefined') { showMessage(escHtml(getText('bip39-not-loaded'))); return; }
            if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
                showMessage('Secure random number generator (crypto.getRandomValues) is not available in this browser.');
                return;
            }
            clearSeedState();
            seedStore.entropy = crypto.getRandomValues(new Uint8Array(seedStore.strength / 8));
            const words = bip39Bundle.entropyToMnemonic(seedStore.entropy).split(' ');
            seedRenderGrid(words, '#seed-word-grid');
            words.fill('');
        }
        $('#seed-btn-print').click(function() {
            if (!seedStore.entropy) return;
            let mn = bip39Bundle.entropyToMnemonic(seedStore.entropy);
            window.seedExportPNG(mn, getText, DEFAULT_DERIV_PATH);
            mn = null;
        });
        $('#seed-btn-to-verify').click(async function() {
            if (!seedStore.entropy) return;
            const $btn = $(this).prop('disabled', true);
            const indices = entropyToIndices(seedStore.entropy);
            const len     = indices.length;
            function rnd(lo, hi) {
                const buf = new Uint32Array(1);
                crypto.getRandomValues(buf);
                return lo + (buf[0] % (hi - lo + 1));
            }
            const third = Math.floor(len / 3);
            const pos   = [rnd(0, third - 1), rnd(third, third * 2 - 1), rnd(third * 2, len - 1)];
            seedStore.verifyPos = pos.map(function(p) { return { pos: p, idx: indices[p] }; });
            indices.fill(0);
            try {
                seedStore.tempKey = await crypto.subtle.generateKey(
                    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
                );
                const iv  = crypto.getRandomValues(new Uint8Array(12));
                const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, seedStore.tempKey, seedStore.entropy);
                seedStore.enc = { iv: Array.from(iv), data: Array.from(new Uint8Array(ct)) };
                seedStore.entropy.fill(0);
                seedStore.entropy = null;
                const $fields = $('#seed-verify-fields').empty();
                pos.forEach(function(p) {
                    $fields.append(
                        '<div class="input-group input-group-sm mb-2">' +
                        '<span class="input-group-text seed-verify-num"><span tkey="seed-word-num">' + escHtml(getText('seed-word-num')) + '</span>&nbsp;' + (p + 1) + '</span>' +
                        '<input type="text" class="form-control font-monospace seed-verify-word" data-pos="' + p + '" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">' +
                        '</div>'
                    );
                });
                $('#seed-verify-error').addClass('d-none');
                $('#seed-create-step1').addClass('d-none');
                $('#seed-create-step2').removeClass('d-none');
                setTimeout(function() { $('.seed-verify-word').first().focus(); }, 100);
            } catch(e) {
                $btn.prop('disabled', false);
                showMessage(escHtml(getText('seed-crypto-error')) + ' ' + escHtml(e.message || String(e)));
            }
        });
        $('#seed-verify-confirm').click(async function(e) {
            e.preventDefault();
            const $btn   = $(this).prop('disabled', true);
            const inputs = $('.seed-verify-word');
            if (!seedStore.verifyPos.length) {
                $('#seed-verify-error').removeClass('d-none');
                $btn.prop('disabled', false);
                return;
            }
            let ok = true;
            const wordlist = bip39Bundle.wordlist;
            for (let i = 0; i < seedStore.verifyPos.length; i++) {
                const vp   = seedStore.verifyPos[i];
                const $inp = inputs.filter('[data-pos="' + vp.pos + '"]');
                const entered = $inp.val().trim().toLowerCase();
                if (wordlist.indexOf(entered) !== vp.idx) { ok = false; break; }
            }
            if (!ok) {
                $('#seed-verify-error').removeClass('d-none');
                $btn.prop('disabled', false);
                return;
            }
            seedStore.verifyPos = [];
            $('#seed-verify-error').addClass('d-none');
            let entropyBytes, privBytes;
            try {
                const iv = new Uint8Array(seedStore.enc.iv);
                const ct = new Uint8Array(seedStore.enc.data);
                entropyBytes = new Uint8Array(await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: iv }, seedStore.tempKey, ct
                ));
                seedStore.enc     = null;
                seedStore.tempKey = null;
                privBytes = bip39Bundle.entropyToPrivKey(entropyBytes, DEFAULT_DERIV_PATH);
                const keyPair = bitcoin.ECPair.fromPrivateKey(bitcoin.Buffer.from(privBytes));
                privBytes.fill(0);
                privBytes = null;
                Keystore.setTempKeyPair(keyPair);
                await openWallet(true, entropyBytes, DEFAULT_DERIV_PATH);
                inputs.each(function() { this.value = ''; });
                seedReset();
                $btn.prop('disabled', false);
            } catch(err) {
                $btn.prop('disabled', false);
                showMessage(escHtml(getText('seed-deriv-error')) + ' ' + escHtml(err.message));
            } finally {
                privBytes?.fill(0);    privBytes    = null;
                entropyBytes?.fill(0); entropyBytes = null;
            }
        });
        $('#restore-wordcount').change(function() {
            const cnt   = parseInt($(this).val(), 10);
            const words = $('#restore-input').val().trim().split(/\s+/).filter(Boolean);
            if (cnt === 12 && words.length > 12) {
                $('#restore-input').val(words.slice(0, 12).join(' '));
            }
            $('#restore-word-error').addClass('d-none');
        });
        $('#seed-restore-btn').click(async function(e) {
            e.preventDefault();
            if (typeof bip39Bundle === 'undefined') { showMessage(escHtml(getText('bip39-not-loaded'))); return; }
            $('#restore-word-error').addClass('d-none');
            let raw          = $('#restore-input').val().trim().toLowerCase().replace(/\s+/g, ' ');
            const words      = raw.split(' ');
            const expectedLen = parseInt($('#restore-wordcount').val(), 10);
            if (words.length !== expectedLen) {
                $('#restore-word-error').text(getText('seed-count-mismatch').replace('{n}', expectedLen).replace('{m}', words.length)).removeClass('d-none');
                return;
            }
            if (!bip39Bundle.validateMnemonic(raw)) {
                $('#restore-word-error').text(getText('seed-invalid-phrase')).removeClass('d-none');
                raw = null;
                return;
            }
            const path = ($('#restore-path').val().trim() || DEFAULT_DERIV_PATH);
            let privBytes, entropyBytes;
            try {
                const $inp = $('#restore-input');
                $inp.val('');
                privBytes    = bip39Bundle.mnemonicToPrivKey(raw, path);
                entropyBytes = bip39Bundle.mnemonicToEntropy(raw);
                raw = null;
                const keyPair = bitcoin.ECPair.fromPrivateKey(bitcoin.Buffer.from(privBytes));
                privBytes.fill(0); privBytes = null;
                Keystore.setTempKeyPair(keyPair);
                await openWallet(true, entropyBytes, path, true);
                seedReset();
            } catch(err) {
                raw = null;
                $('#restore-word-error').text(getText('seed-deriv-error') + ' ' + err.message).removeClass('d-none');
            } finally {
                privBytes?.fill(0);    privBytes    = null;
                entropyBytes?.fill(0); entropyBytes = null;
            }
        });
        $('#btn-show-seed').click(async function() {
            if (!hasSeedBackup()) return;
            async function onPasskeyChosen(retriesLeft) {
                if (retriesLeft === undefined) retriesLeft = 2;
                let credIdStr = null;
                try { credIdStr = localStorage.getItem(STORAGE_KEY_PK_ID); } catch(e) {}
                if (!credIdStr) { showMessage(escHtml(getText('passkey-not-setup'))); return; }
                try {
                    const assertion = await navigator.credentials.get({
                        publicKey: {
                            challenge:        crypto.getRandomValues(new Uint8Array(32)),
                            rpId:             window.location.hostname,
                            allowCredentials: [{ type: 'public-key', id: b64ToCredId(credIdStr) }],
                            userVerification: 'required',
                            extensions:       { prf: { eval: { first: PK_PRF_SALT } } }
                        }
                    });
                    const ext = assertion.getClientExtensionResults();
                    if (!ext.prf || !ext.prf.results || !ext.prf.results.first) {
                        showMessage(escHtml(getText('passkey-prf-unsupported')));
                        return;
                    }
                    const prfBytes  = new Uint8Array(ext.prf.results.first);
                    const seedBytes = await loadEncryptedBytesWithKey(STORAGE_KEY_SEED_PK, prfBytes);
                    prfBytes.fill(0);
                    if (!seedBytes) {
                        showMessage(escHtml(getText('passkey-decrypt-failed')));
                        return;
                    }
                    revealSeedFromBytes(seedBytes);
                } catch(e) {
                    if (e.name === 'NotAllowedError') return;
                    if (retriesLeft > 0 && isTransientPasskeyError(e)) {
                        await new Promise(function(r) { setTimeout(r, 300); });
                        return onPasskeyChosen(retriesLeft - 1);
                    }
                    showMessage(escHtml(getText('passkey-error')) + escHtml(e.message));
                }
            }
            const title         = getText('seed-pin-modal-title');
            const desc          = getText('seed-pin-modal-desc');
            const canUsePasskey = isPasskeyEnabled() && hasSeedPkBackup();
            const seedPinValidator = async function(candidate) {
                const priv = await loadEncryptedBytes(STORAGE_KEY_PRIV, candidate);
                if (!priv) return getText('pin-login-error');
                priv.fill(0);
                return null;
            };
            let pin = await askPin(title, desc, seedPinValidator, false, canUsePasskey ? onPasskeyChosen : null);
            if (pin === null) return;
            const entropyBytes = await loadEncryptedBytes(STORAGE_KEY_SEED, pin);
            pin = null;
            if (!entropyBytes) return;
            revealSeedFromBytes(entropyBytes);
        });
        $('#btn-hide-seed').click(hideSeedReveal);
        $('#btn-save-seed-png').click(function() {
            const pending = seedStore.getPending();
            if (!pending) return;
            let mn = bip39Bundle.entropyToMnemonic(pending);
            let savedPath; try { savedPath = localStorage.getItem(STORAGE_KEY_PATH); } catch(e) {}
            window.seedExportPNG(mn, getText, savedPath || DEFAULT_DERIV_PATH);
            mn = null;
        });
    });
    function wsConnect() {
        if (typeof io === 'undefined') return;
        if (!globalData.address)       return;
        if (ws && wsActive)          return;
        wsDisconnect();
        const backend = getBackend();
        try {
            ws = io(backend, {
                path:                 '/socket.io',
                transports:           ['websocket'],
                reconnectionDelay:    5000,
                reconnectionDelayMax: 30000,
                timeout:              10000
            });
        } catch(e) {
            return;
        }
        ws.on('connect', function() {
            wsActive = true;
            if (globalData.address) {
                ws.emit('subscribe', { address: globalData.address });
            }
        });
        ws.on('block', function(data) {
            if (globalData.status !== 'unlocked') return;
            if (!data || typeof data.height !== 'number') return;
            const prevHeight = globalData.height;
            globalData.height = data.height;
            if (globalData.utxos.length > 0) {
                const h = globalData.height;
                globalData.utxos.forEach(function(u) {
                    u.mature     = isUtxoMature(u, h);
                    u.blocksLeft = blocksToMature(u, h);
                });
                applyUtxoData();
            }
            if (globalData.height !== prevHeight && globalData.address) {
                TxHistory.updateHistory();
            }
        });
        ws.on('balance_changed', function(data) {
            if (globalData.status !== 'unlocked') return;
            if (data && typeof data.confirmed === 'number' && Array.isArray(data.utxos)) {
                const prevBalance     = globalData.balance;
                const prevUnconfirmed = globalData.unconfirmedBalance;
                globalData.balance    = data.confirmed;
                globalData.pendingOut = typeof data.pending_out === 'number' ? data.pending_out : 0;
                if (typeof data.height === 'number') {
                    globalData.height = data.height;
                }
                const h = globalData.height;
                globalData.utxos = data.utxos.map(function(u) {
                    return Object.assign({}, u, {
                        mature:     isUtxoMature(u, h),
                        blocksLeft: blocksToMature(u, h)
                    });
                });
                saveUtxoCache(globalData.address, globalData.utxos, h, data.confirmed, data.pending_out || 0);
                applyUtxoData();
                if ((globalData.balance !== prevBalance || globalData.unconfirmedBalance !== prevUnconfirmed) && globalData.address) {
                    TxHistory.updateHistory();
                }
            }
        });
        ws.on('disconnect', function() {
            wsActive = false;
        });
        ws.on('connect_error', function() {
            wsActive = false;
        });
    }
    function wsDisconnect() {
        if (ws) {
            try { ws.disconnect(); } catch(e) {}
            ws       = null;
            wsActive = false;
        }
    }
    window.setTheme = setTheme;
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js').catch(function (err) {
                console.warn('SW registration failed:', err);
            });
        });
    }
})();
