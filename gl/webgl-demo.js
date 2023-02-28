"use strict";

$(document).ready(function() {
    const console_output = $('#console_output');
    
    window["myconsole"] = {
        log: function(...args) {
            console.log(...args);
            console_output.append('<p class="log">' + args.join("\t") + "</p>");
        },
        error: function(...args) {
            console.error(...args);
            console_output.append('<p class="error">' + args.join("\t") + "</p>");
            $("#control-panel").accordion("option", "active", -1);
        }
    };
    
    if (window["myerrors"].length) {
        for (let error_dict of window["myerrors"])
            window["myconsole"].error(error_dict.error, "@" + error_dict.url + ":" + error_dict.lineNo);
        return;
    }
    
    
    const i = new WebGLInterface();
    
    
    // Populate the list of worlds with the default test list
    fetch("../tests/list.json").then(response => response.json()).then(function(json) {
        for (let o of json.sort())
            $("#test-select").append(`<option value="${o}">${o}</option>`);
        
        const URLTest = new URLSearchParams(window.location.search).get('test');
        if (URLTest) {
            if (json.indexOf(URLTest) >= 0)
                $("#test-select").val(URLTest);
            loadTest(URLTest);
        }
    });
    
    window.onpopstate = function(e) {
        if (e.state && e.state.test)
            loadTest(e.state.test);
    }
    
    $("#test-select").on("change", function() {
        i.stopDrawLoop();
        
        const test = $("#test-select").val();
        
        window.history.pushState({ test: test }, test, test ? ("?test=" + test) : "");
        
        if (test === "")
            return;
        
        loadTest(test);
    });
    
    function loadTest(test) {
        $("#loading-img").css('visibility', 'visible');
        
        myconsole.log("Loading " + test + "...");
        import("../tests/" + test + "/test.js").then(function(module) {
            module.configureTest(function(test) {
                i.changeTest(test);
            });
        }, function(e) {
            myconsole.error(e);
            $("#loading-img").css('visibility', 'hidden');
        });
    }
});

