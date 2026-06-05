(function () {
    'use strict';
    function seedExportPNG(mnemonic, getText, path) {
        if (!mnemonic) return;
        const displayPath = path || "m/84'/738'/0'/0/0";
        const words       = mnemonic.split(' ');
        const cols        = 4;
        const rows        = Math.ceil(words.length / cols);
        const W       = 800;
        const padX    = 44;
        const padY    = 36;
        const headerH = 72;
        const warnH   = 46;
        const cellW   = Math.floor((W - padX * 2) / cols);
        const cellH   = 40;
        const gridH   = rows * cellH;
        const pathH   = 36;
        const footerH = 38;
        const H       = padY + headerH + warnH + 16 + gridH + 16 + pathH + footerH + padY;
        const canvas = document.createElement('canvas');
        const dpr    = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width  = W * dpr;
        canvas.height = H * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle    = '#c0392b';
        ctx.fillRect(0, padY, W, headerH);
        ctx.fillStyle    = '#ffffff';
        ctx.font         = 'bold 22px system-ui, sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(getText('seed-print-secret'), W / 2, padY + headerH / 2);
        ctx.fillStyle = '#7b1a12';
        ctx.fillRect(0, padY + headerH, W, warnH);
        ctx.fillStyle = '#fff3f3';
        ctx.font      = '13px system-ui, sans-serif';
        ctx.fillText(getText('seed-print-warning'), W / 2, padY + headerH + warnH / 2);
        const gridTop = padY + headerH + warnH + 16;
        ctx.textBaseline = 'middle';
        words.forEach(function (word, i) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x   = padX + col * cellW;
            const y   = gridTop + row * cellH;
            const cx  = x + cellW / 2;
            const cy  = y + cellH / 2;
            ctx.fillStyle = (row + col) % 2 === 0 ? '#f7f8fa' : '#eef0f4';
            if (ctx.roundRect) {
                ctx.beginPath(); ctx.roundRect(x + 2, y + 2, cellW - 4, cellH - 4, 6); ctx.fill();
            } else {
                ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);
            }
            ctx.strokeStyle = '#d0d4dc';
            ctx.lineWidth   = 1;
            if (ctx.roundRect) {
                ctx.beginPath(); ctx.roundRect(x + 2, y + 2, cellW - 4, cellH - 4, 6); ctx.stroke();
            } else {
                ctx.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4);
            }
            ctx.fillStyle = '#9ca3af';
            ctx.font      = '11px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(i + 1, x + 10, cy);
            ctx.fillStyle = '#1a1a2e';
            ctx.font      = 'bold 15px system-ui, monospace';
            ctx.textAlign = 'center';
            ctx.fillText(word, cx + 8, cy);
        });
        const pathY      = gridTop + gridH + 16;
        const pathSuffix = displayPath === "m/84'/738'/0'/0/0" ? '  (BIP84 native SegWit, BTE)' : '';
        ctx.fillStyle    = '#f0f2f5';
        ctx.fillRect(padX, pathY, W - padX * 2, pathH);
        ctx.fillStyle    = '#374151';
        ctx.font         = '12px system-ui, monospace';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(getText('seed-path-label') + '  ' + displayPath + pathSuffix, padX + 12, pathY + pathH / 2);
        const footerY = pathY + pathH;
        const now     = new Date();
        const dateStr = now.getFullYear() + '-' +
                        String(now.getMonth() + 1).padStart(2, '0') + '-' +
                        String(now.getDate()).padStart(2, '0');
        ctx.fillStyle    = '#9ca3af';
        ctx.font         = '11px system-ui, sans-serif';
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('Generated ' + dateStr, W - padX, footerY + footerH / 2);
        words.fill('');
        try {
            const link      = document.createElement('a');
            link.href     = canvas.toDataURL('image/png');
            link.download = 'seed-backup-' + dateStr + '.png';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (e) {
            window.open(canvas.toDataURL('image/png'), '_blank');
        }
    }
    window.seedExportPNG = seedExportPNG;
})();
