(function (package) {
    if (typeof exports === 'object')
        package(require('S'), require('htmlliterals-runtime')); // CommonJS
    else if (typeof define === 'function')
        define(['S', 'htmlliterals-runtime'], package); // AMD
    else package(S, htmlliterals); // globals
})(function (S, htmlliterals) {
    var type = 'text/javascript-htmlliterals';

    preprocessAllScripts();

    function preprocessAllScripts() {
        var scr;
        while (scr = document.querySelector("script[type='" + type + "']")) {
            scr.type += '-processed';
            preprocess(scr.textContent || scr.innerText || scr.innerHTML);
        }
    }

    function preprocess(str) {
        var src = htmlliterals.preprocess(str),
            script = document.createElement('script');

        script.type = 'text/javascript';
        script.src  = 'data:text/javascript;charset=utf-8,' + escape(src);

        document.body.appendChild(script);
    }
});
