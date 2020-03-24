var gulp = require('gulp');
var nodeunit = require('gulp-nodeunit');
var browserify = require("browserify");
var source = require('vinyl-source-stream');
var serve = require('gulp-serve');
var fs = require('fs');


var http = require("https");

var fetch = function (url, c) {
    var acc = "";
    http.get(url, function (res) {
        res.on('data', function (d) {
            acc += d;
        });
        res.on('end', function () {
            c(acc);
        });
    });
};

gulp.task('browserify', function() {
    if (fs.existsSync('dist/shacl.js')) {
        fs.unlinkSync('dist/shacl.js');
    }

    return browserify('./index.js')
        .bundle()
        //Pass desired output filename to vinyl-source-stream
        .pipe(source('shacl.js'))
        // Start piping stream to tasks!
        .pipe(gulp.dest('./dist/'));
});

gulp.task('checkJavaFiles', function (cb) {
    var files = [
        //"./vocabularies/dash.ttl": "https://raw.githubusercontent.com/TopQuadrant/shacl/master/src/main/resources/etc/dash.ttl",
        ["./vocabularies/shacl.ttl", "https://raw.githubusercontent.com/TopQuadrant/shacl/master/src/main/resources/rdf/shacl.ttl"],
        ["./shared/dash.js", "https://raw.githubusercontent.com/TopQuadrant/shacl/master/src/main/resources/js/dash.js"],
        ["./shared/rdfquery.js", "https://raw.githubusercontent.com/TopQuadrant/shacl/master/src/main/resources/js/rdfquery.js"]
    ];

    var uptodate = true;
    var checkFile = function (fileInfo, cb) {
        var p = fileInfo[0];
        var url = fileInfo[1];
        var read = fs.readFileSync(p).toString();
        fetch(url, function (data) {
            console.log(url);
            console.log(read === data);
            uptodate = uptodate && (read === data);
            cb();
        });
    };

    var checkFiles = function (files) {
        if (files.length === 0) {
            if (uptodate) {
                cb();
            } else {
                cb(new Error("Some Java files are not in sync"));
            }
        } else {
            var file = files.shift();
            checkFile(file, function () {
                checkFiles(files);
            });
        }
    };

    checkFiles(files);
});

gulp.task('test', function (done) {
    gulp.src('./test/**/*.js').pipe(nodeunit({}));
    done();
});

/*
gulp.task('browserify', function (done) {
    if (fs.existsSync('dist/index.js')) {
        fs.unlinkSync('dist/index.js');
    }
    if (fs.existsSync('dist/shacl.js')) {
        fs.unlinkSync('dist/shacl.js');
    }
    gulp.src('index.js')
        .pipe(browserify({
            standalone: 'SHACLValidator'
        }))
        .pipe(gulp.dest('dist'))
        .on('end', function () {
            fs.renameSync('dist/index.js', 'dist/shacl.js');
            done();
        });
});
*/

gulp.task('generate-vocabularies', function () {
    var vocabularies = fs.readdirSync("./vocabularies");
    var acc = {};
    for (var i = 0; i < vocabularies.length; i++) {
        console.log("Generating " + vocabularies[i]);
        acc[vocabularies[i].split(".ttl")[0]] = fs.readFileSync("./vocabularies/" + vocabularies[i]).toString();
        fs.writeFileSync("./src/vocabularies.js", "module.exports = " + JSON.stringify(acc));
    }
});

/**
 * We generate rdfquery from the shared library and we add it to the validator code and to the
 * list of libraries that must be loaded.
 * Dash.js is only added to the list of loaded libraries.
 */
gulp.task('generate-libraries', function (done) {
    var libraries = {
        "http://datashapes.org/js/dash.js": "./shared/dash.js",
        "http://datashapes.org/js/rdfquery.js": "./shared/rdfquery.js"
    };
    var acc = {};
    for (var library in libraries) {
        console.log("Generating " + library);
        acc[library] = fs.readFileSync(libraries[library]).toString();
        fs.writeFileSync("./src/libraries.js", "module.exports = " + JSON.stringify(acc));
    }

    var rdfqueryTemplate = fs.readFileSync("./templates/rdfquery.js").toString();
    var rdfqueryData = fs.readFileSync("./shared/rdfquery.js").toString();
    var generated = rdfqueryTemplate.replace("</content>", rdfqueryData);
    fs.writeFileSync("./src/rdfquery.js", generated);
    done()
});

gulp.task('browserify-public-tests', function () {
    if (fs.existsSync('public/test.js')) {
        fs.unlinkSync('public/test.js');
    }
    fs.createReadStream('dist/shacl.js').pipe(fs.createWriteStream('public/shacl.js'));
    gulp.src('public/src/test.js')
        .pipe(browserify())
        .pipe(gulp.dest('public'));
});

gulp.task('generate-public-test-cases', function () {
    var testCases = [];

    if (!fs.existsSync(__dirname + "/public/data"))
        fs.mkdirSync(__dirname + "/public/data");

    fs.readdirSync(__dirname + "/test/data/core").forEach(function (dir) {
        fs.readdirSync(__dirname + "/test/data/core/" + dir).forEach(function (file) {
            var read = fs.readFileSync(__dirname + "/test/data/core/" + dir + "/" + file).toString();
            fs.writeFileSync(__dirname + "/public/data/" + dir + "_" + file, read);
            testCases.push("data/" + dir + "_" + file);
        });
    });

    fs.writeFileSync(__dirname + "/public/test_cases.json", JSON.stringify(testCases));
});


gulp.task('test-web', gulp.series('generate-public-test-cases', 'browserify-public-tests', serve('public'), function(done) {
    done();
}));

gulp.task('default', gulp.series('test', 'browserify', function(done) {
    done();
}));
