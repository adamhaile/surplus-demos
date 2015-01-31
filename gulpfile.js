var gulp = require('gulp'),
    concat = require('gulp-concat'),
    uglify = require('gulp-uglify'),
    rename = require('gulp-rename');

var srcs = [
        "../S/dist/S.js",
        "../htmlliterals-preprocessor/dist/htmlliterals-preprocessor.js",
        "../htmlliterals-runtime/dist/htmlliterals-runtime.js",
        "../S-htmlliterals/src/S-htmlliterals.js",
        "src/bootstrap.js"
    ],
    runtime = [
        "../S/dist/S.js",
        "../htmlliterals-runtime/dist/htmlliterals-runtime.js",
        "../S-htmlliterals/src/S-htmlliterals.js"
    ];

gulp.task('dist', function() {
    gulp.src(srcs)
    .pipe(concat("surplus.js"))
    .pipe(gulp.dest("dist"))
    .pipe(rename("surplus.min.js"))
    .pipe(uglify())
    .pipe(gulp.dest("dist"));

    gulp.src(runtime)
    .pipe(concat("surplus-runtime.js"))
    .pipe(gulp.dest("dist"))
    .pipe(rename("surplus-runtime.min.js"))
    .pipe(uglify())
    .pipe(gulp.dest("dist"));
});

gulp.task('default', ['dist']);
gulp.watch(srcs, ['dist']);
