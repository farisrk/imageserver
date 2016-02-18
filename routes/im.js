var path = require('path'),
    util = require('util'),
    async = require('async'),
    exec = require('child_process').exec,
    Log = require('../../anf-libs/libs/Logger');

module.exports = function(app, formidable, fs, os, gm, options) {
    var imageMagick = gm.subClass({ imageMagick: true });

    app.get('/', function(req, res, next) {
        // prompt user to upload file(s)
        res.render('index');
    });

    // Expect the payload to include app (application name)
    // and numFiles (number of files uploaded) fields
    var allowedOrigins = [
        'http://plowtownmgr.newt-az.airg.us',
        'http://fk-server.airg.us:5000',
        'http://plowtownmgr.airg.com'
    ];
    app.post('/upload', function(req, res, next) {
        var application;
        var uploadedFiles = [];
        var newForm = new formidable.IncomingForm();
        newForm.keepExtensions = true;
        newForm.parse(req, function(err, fields, files) {
            // default the application to bbw
            application = fields.app || 'bbw';
            var numFiles = fields.numFiles;

            if (numFiles && numFiles > 0) {
                for (var i = 0; i < fields.numFiles; i++) {
                    var file = files['upload'+i];
                    if (file) {
                        var hash = {
                            app: application,
                            tmpFile: file.path,
                            fileName: file.name
                        };
                        uploadedFiles.push(hash);
                        // TODO: check if file with same name already exists, if so
                    }
                };
                if (allowedOrigins.indexOf(req.headers.origin) !== -1)
                    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': req.headers.origin });
            } else {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
            }

            res.end();
        });

        newForm.on('end', function() {
            uploadedFiles.forEach(initializeImg);
        });
    });

    app.get('/:app/:image/:width/:height/:type', function(req, res, handleError) {
        var appName = req.params.app,
            base = req.params.image,
            width = req.params.width,
            height = req.params.height,
            type = req.params.type,
            overlays = req.query.overlay;
        if (overlays) overlays = overlays.toString().split(',');
        else overlays = [];
        width = Math.min(width, 300);
        height = Math.min(height, 300);

        var animated = false;
        if (req.query.hasOwnProperty('animated'))
            animated = req.query.animated == 1;
        if (animated) {
            if (type !== 'gif') return res.status(400).send("Animated images have to be type gif!");
        }

        var bucket = '';
        if (req.query.hasOwnProperty('bucket'))
            bucket = req.query.bucket;

        // build the file name and file paths to the source and destination files
        // ex: basic_300x300_0_a_b_c.jpg where overlay = 'a,b,c'
        var fname = base + '_' + width + 'x' + height + '_' + (animated ? 1 : 0);
        for (var i = 0; i < overlays.length; i++) {
            var parts = overlays[i].toString().split('/');
            fname += '_' + parts[parts.length-1];
        };
        fname += '.' + type;

        var baseFile = base + (animated ? '.gif' : '.png');
        var appPath = path.join(app.get('imageContainer'), '/', appName);
        var srcPath = path.join(appPath, app.get('uploadDir'));
        if (bucket) baseFile = path.join(bucket, '/', baseFile);
        var srcFilePath = path.join(srcPath, '/', baseFile);
        var dstPath = path.join(appPath, app.get('workingDir'));
        var dstFilePath = path.join(dstPath, '/', fname);

        async.series([
            // make sure the directory exists
            function(next) { exec(('mkdir -p ' + dstPath), next); },
            // try reading the file and serving it
            function(next) {
                if (options.hasOwnProperty('generateNewImages') && options.generateNewImages)
                    return next();
                //if (options.hasOwnProperty('debug') && options.debug)
                //    return next();

                serveFile(res, type, dstFilePath, function(err) {
                    // file doesn't exist, continue the series to create file
                    if (err) return next();
                    // file was served, nothing else to do!
                    return handleError();
                });
            },
            function(next) {
                Log.debug('create image file...');
                processFile(srcPath, srcFilePath, dstFilePath, width, height, animated, overlays, next);
            },
            function(next) {
                serveFile(res, type, dstFilePath, next);
            }
        ], function(err) {
            if (err) Log.error('error: ' + err);
            return handleError(err);
        });
    });

    function serveFile(res, type, path, callback) {
        fs.readFile(path, function(err, data) {
            if (err) return callback(err);

            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.writeHead(200, { 'Content-Type': 'image/' + type });
            res.end(data); // Send the file data to the browser.
            return callback();
        });
    }

    function initializeImg(job) {
        var tmpFile = job.tmpFile;
        var fileName = job.fileName;
        var newPath = path.join(app.get('imageContainer'), '/', job.app, app.get('uploadDir'));
        var newFile = path.join(newPath, '/', fileName);


        async.series([
            function(next) {
                // make sure the path exists
                exec(('mkdir -p ' + newPath), next);
            },
            function(next) {
                // additional logic of animated gifs
                if (!tmpFile.match(/\.gif$/i)) return next();

                exec(('identify -format %n ' + tmpFile), function(err, numFrames) {
                    if (err) return next();
                    if (parseInt(numFrames) === 1) return next();

                    // copy the animated gif
                    exec(('mv ' + tmpFile + ' ' + newFile), function(err) {
                        if (err) return next(err);
                        // extract a single frame.. copy to t he tmpFile location
                        exec(('convert ' + newFile + '[0] ' + tmpFile), next);
                    });
                });
            },
            function(next) {
                // convert to PNG format
                newFile = newFile.replace(/(?:\.([^.]+))?$/, ".png");
                // convert to PNG
                exec(('convert ' + tmpFile + ' ' + newFile), next);
            },
            function(next) {
                // remove the temporary file
                exec(('rm -f ' + tmpFile), function(err) {
                    // TODO: log error if there is an error
                    //if (err)
                    return next();
                });
            }

        ], function(err) {
            if (err) Log.error("Encountered error while uploading image: " + err.message);
            else Log.debug('Finished uploading the initializing the images!');
        });
    }

    function processFile(srcPath, srcFilePath, dstFilePath, width, height, animated, overlays, callback) {
        // var exec = require('child_process').exec;
        // var command = [
        //     'gm', 'convert'
        //     '-composite',
        //     '-watermark', '20x50',
        //     '-gravity', 'center',
        //     '-quality', 100,
        //     'images/watermark.png',
        //     'images/input.jpg', //input
        //     'images/watermarked.png'  //output
        // ];
        //  // making watermark through exec - child_process
        // exec(command.join(' '), function(err, stdout, stderr) {
        //     if (err) console.log(err);

        // });
        // gm convert -size 500x500 basic.png -resize 500x500 _composed_9.png
        // gm convert -size 500x500 basic.png WasabiSeeds_growing.png water.png -flatten -resize 500x500 _composed_8.png
        // gm convert -size 500x500 -coalesce TrophyCamelSpit.gif -resize 500x500 anim_resize_12.gif
        // gm convert -size 500x500 -coalesce TrophyCamelSpit.gif water.png -flatten -resize 500x500 anim_composite_resize_1.gif

        var dimension = width + 'x' + height;
        var command = [
            'convert',
            '-size', dimension
        ];
        if (animated) {
            command.unshift('gm');
            command.push('-coalesce');
            command.push(srcFilePath);
            command.push('-resize', dimension);
            //gm convert -size 500x500 -coalesce /home/main/MyImageServer/content/bbw/raw/TrophyMyNameIsSenorSpud.gif -resize 500x500 content/bbw/test/animation_test_7.gif
        } else {
            command.push(util.format("\\( %s -resize %s \\)", srcFilePath, dimension));
            if (options.debug) overlays.push('watermark');
            if (overlays.length > 0) {
                for (var i = 0; i < overlays.length; i++) {
                    var overlayFilePath = path.join(srcPath, '/', overlays[i] + '.png');
                    command.push(util.format("\\( %s -resize %s \\)", overlayFilePath, dimension));
                }
                command.push('-background', 'none');
                command.push('-flatten');
            }
            // convert -size 60x60 /
            // \( /home/main/MyImageServer/content/bbw/raw/BabySnowshoeHare.png -resize 60x60 \) /
            // \( /home/main/MyImageServer/content/bbw/raw/friend.png -resize 60x60 \) /
            // \( /home/main/MyImageServer/content/bbw/raw/watermark.png -resize 60x60 \) /
            // -background none -flatten /home/main/MyImageServer/content/bbw/serve/BabySnowshoeHare_60x60_0_friend.png
        }

        command.push(dstFilePath);
        console.log("image magick command:", command.join(' '));
        exec(command.join(' '), callback);
    }
}
