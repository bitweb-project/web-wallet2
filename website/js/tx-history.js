(function () {
    'use strict';
    const HISTORY_LIMIT = 10;
    class TxHistoryManager {
        #globalData    = null;
        #escHtml       = null;
        #getText       = null;
        #getBackend    = null;
        #getConfig     = null;
        #amountFormat  = null;
        #blockExplorer = null;
        init(deps) {
            this.#globalData    = deps.globalData;
            this.#escHtml       = deps.escHtml;
            this.#getText       = deps.getText;
            this.#getBackend    = deps.getBackend;
            this.#getConfig     = deps.getConfig;
            this.#amountFormat  = deps.amountFormat;
            this.#blockExplorer = deps.blockExplorer;
            $(document).off('click.hcopy').on('click.hcopy', '.h-copy-btn', function () {
                const url       = $(this).data('copy-url');
                const $btn      = $(this);
                if (!url) return;
                const $icon     = $btn.find('.fa-solid, .fa-regular').first();
                const origClass = $icon.attr('class');
                const done = (ok) => {
                    if ($icon.length) $icon.attr('class', 'fa-solid ' + (ok ? 'fa-check' : 'fa-times'));
                    $btn.addClass(ok ? 'btn-success' : 'btn-danger').removeClass('btn-outline-secondary');
                    setTimeout(() => {
                        if ($icon.length) $icon.attr('class', origClass);
                        $btn.removeClass('btn-success btn-danger').addClass('btn-outline-secondary');
                    }, 1500);
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(url).then(() => done(true)).catch(() => {
                        try { const ta = document.createElement('textarea');
                              ta.value = url; ta.style.cssText = 'position:fixed;opacity:0';
                              document.body.appendChild(ta); ta.select();
                              document.execCommand('copy'); document.body.removeChild(ta); done(true);
                        } catch (_) { done(false); }
                    });
                } else {
                    try { const ta = document.createElement('textarea');
                          ta.value = url; ta.style.cssText = 'position:fixed;opacity:0';
                          document.body.appendChild(ta); ta.select();
                          document.execCommand('copy'); document.body.removeChild(ta); done(true);
                    } catch (_) { done(false); }
                }
            });
        }
        loadHistory() {
            const key = 'bte_history_' + this.#globalData.address;
            try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
        }
        saveHistory(txs) {
            if (!this.#globalData.address) return;
            try {
                localStorage.setItem('bte_history_' + this.#globalData.address, JSON.stringify(txs));
            } catch (e) {}
        }
        async updateHistory() {
            if (this.#globalData.status !== 'unlocked') return;
            const requestedAddress = this.#globalData.address;
            $('#history-list').html(
                '<div class="text-muted text-center py-3 small">' +
                this.#escHtml(this.#getText('history-loading')) + '</div>'
            );
            const url = this.#getBackend() + '/history/' + encodeURIComponent(requestedAddress)
                      + '?limit=' + HISTORY_LIMIT;
            try {
                const r    = await fetch(url);
                const data = await r.json();
                if (this.#globalData.address !== requestedAddress) return;
                if (data.error != null) {
                    $('#history-list').html(
                        '<div class="text-danger text-center py-3 small">' +
                        this.#escHtml(this.#getText('history-failed')) + '</div>'
                    );
                    return;
                }
                const txs = Array.isArray(data.result) ? data.result : [];
                this.saveHistory(txs);
                this.renderHistory(txs);
            } catch {
                const cached = this.loadHistory();
                if (cached.length) {
                    this.renderHistory(cached);
                } else {
                    $('#history-list').html(
                        '<div class="text-danger text-center py-3 small">' +
                        this.#escHtml(this.#getText('history-network-error')) + '</div>'
                    );
                }
            }
        }
        #formatTs(ts) {
            if (!ts) return '';
            const d   = new Date(ts * 1000);
            const pad = n => n < 10 ? '0' + n : String(n);
            return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' +
                   d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }
        renderHistory(txs) {
            if (!txs || txs.length === 0) {
                $('#history-list').html(
                    '<div class="text-muted text-center py-3 small">' +
                    this.#escHtml(this.#getText('no-transactions')) + '</div>'
                );
                return;
            }
            const ticker = this.#getConfig()['ticker'];
            const chainHeight = Number(this.#globalData.height);
            let html = '<div class="history-overflow"><table id="history-table"><thead>' +
                       '<tr><th>' + this.#escHtml(this.#getText('amount')) + '</th>' +
                       '<th>' + this.#escHtml(this.#getText('transaction')) + '</th>' +
                       '<th>' + this.#escHtml(this.#getText('date')) + '</th>' +
                       '<th></th>' +
                       '<th>' + this.#escHtml(this.#getText('status')) + '</th>' +
                       '</thead><tbody>';
            txs.forEach(tx => {
                const h = Number(tx.height);
                const confirmed = h > 0;
                let confBadge = '';
                if (confirmed) {
                    let confText = (chainHeight > 0)
                        ? String(Math.max(0, chainHeight - h + 1)) + ' ' + this.#getText('history-conf')
                        : this.#getText('history-confirmed');
                    confBadge = '<span class="badge text-bg-success">' + this.#escHtml(confText) + '</span>';
                } else {
                    confBadge = '<span class="badge text-bg-warning">' + this.#escHtml(this.#getText('history-pending')) + '</span>';
                }
                const dir = tx.direction || 'unknown';
                const amt = (tx.amount != null) ? this.#amountFormat(tx.amount) : '?';
                let dirLabelClass = '', dirSymbol = '';
                if (dir === 'in') {
                    dirLabelClass = 'text-success';
                    dirSymbol = '↓ +';
                } else if (dir === 'out') {
                    dirLabelClass = 'text-danger';
                    dirSymbol = '↑ −';
                } else if (dir === 'self') {
                    dirLabelClass = 'text-info';
                    dirSymbol = '↻';
                } else {
                    dirLabelClass = 'text-muted';
                    dirSymbol = '?';
                }
                const dirLabel = '<span class="tx-dir-label ' + dirLabelClass + '">' +
                                 dirSymbol + ' ' + this.#escHtml(String(amt)) + ' ' + this.#escHtml(ticker) +
                                 '</span>';
                const safeHashFull  = this.#escHtml(tx.txid || '');
                const rawTxUrl      = this.#blockExplorer.tx(tx.txid || '');
                const txUrl         = this.#escHtml(rawTxUrl);
                const tsHtml        = tx.timestamp
                    ? '<span class="history-ts">' + this.#escHtml(this.#formatTs(tx.timestamp)) + '</span>'
                    : '<span class="history-ts"></span>';
                const copyBtn = '<button class="btn btn-sm btn-outline-secondary h-copy-btn" data-copy-url="' + txUrl + '">' +
                               '<span class="fa-solid fa-copy"></span></button>';
                /* desktop: one row */
                html += '<tr class="tx-row-desk">' +
                        '<td class="tx-dir-cell">' + dirLabel + '</td>' +
                        '<td class="history-tx-hash">' +
                            '<a href="' + txUrl + '" target="_blank" rel="noopener noreferrer">' + safeHashFull + '</a>' +
                        '</td>' +
                        '<td class="history-ts-cell">' + tsHtml + '</td>' +
                        '<td class="h-copy-cell">' + copyBtn + '</td>' +
                        '<td class="h-badge-cell">' + confBadge + '</td>' +
                        '</tr>';
                /* mobile: two rows */
                html += '<tr class="tx-row-mob tx-row-mob-1">' +
                        '<td class="tx-dir-cell" colspan="4">' + dirLabel + '</td>' +
                        '<td class="h-badge-cell">' + confBadge + '</td>' +
                        '</tr>';
                html += '<tr class="tx-row-mob tx-row-mob-2">' +
                        '<td class="history-tx-hash-m" colspan="3">' +
                            '<div class="hash-m-inner">' +
                                '<a href="' + txUrl + '" target="_blank" rel="noopener noreferrer">' + safeHashFull + '</a>' +
                            '</div>' +
                        '</td>' +
                        '<td class="history-ts-cell">' + tsHtml + '</td>' +
                        '<td class="h-copy-cell">' + copyBtn + '</td>' +
                        '</tr>';
            });
            html += '</tbody></table></div>';
            // Add explorer link below the table (view all)
            if (txs.length >= HISTORY_LIMIT) {
                const explorerUrl = this.#escHtml(this.#blockExplorer.address(this.#globalData.address));
                html += '<div class="text-center py-2"><small>' +
                        '<a href="' + explorerUrl + '" target="_blank" rel="noopener noreferrer">' +
                        this.#escHtml(this.#getText('history-view-all')) + ' &#x2197;' +
                        '</a></small></div>';
            }
            $('#history-list').html(html);
        }
    }
    window.TxHistory = new TxHistoryManager();
})();
