(function(){
    'use strict';
    let t;
    try { t = localStorage.getItem('bte_cfg_theme') } catch(e) { t = null }
    const resolved = (!t || t === 'auto')
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : t;
    document.documentElement.setAttribute('data-bs-theme', resolved);
})();
