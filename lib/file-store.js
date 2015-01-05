var path = require('path'),
    fs = require('fs'),
    debug = require('debug')('FileStore'),
    async = require('async'),
    md5 = require('MD5'),
    mkdirp = require('mkdirp'),
    utils = require('./utils'),
    _ = require('lodash');

var FileStore = function (rootDirectory) {
  var CONTENT_FILE = '.dummys3_content',
      METADATA_FILE = '.dummys3_metadata',
      Bucket = require('./models/bucket'),
      S3Object = require('./models/s3-object');


  var getBucketPath = function (bucketName) {
    return path.join(rootDirectory, bucketName);
  };

  var getBucket = function (bucketName, done) {
    var bucketPath = getBucketPath(bucketName);
    fs.stat(bucketPath, function (err, file) {
      if (err || !file.isDirectory()) {
        return done('Bucket not found');
      }
      return done(null, new Bucket(bucketName, file.ctime));
    });
  };

  var deleteBucket = function (bucket, done) {
    var bucketPath = getBucketPath(bucket.name);
    fs.rmdir(bucketPath, function (err) {
      if (err) {
        return done(err);
      }
      return done();
    });
  };

  var getBuckets = function () {
    var buckets = [];
    fs.readdirSync(rootDirectory).filter(function (result) {
      var file = fs.statSync(path.resolve(rootDirectory, result));
      if (file.isDirectory()) {
        buckets.push(new Bucket(result, file.ctime));
      }
    });
    return buckets;
  };

  var putBucket = function (bucketName, done) {
    var bucketPath = getBucketPath(bucketName);
    fs.mkdir(bucketPath, 502, function (err) {
      return getBucket(bucketName, done);
    });
  };

  var getObject = function (bucket, key, done) {
    var filePath = path.resolve(getBucketPath(bucket.name), key);
    fs.exists(filePath, function (exists) {
      if (exists === false) {
        return done('Not found');
      }
      async.parallel([
        function (callback) {
          fs.readFile(path.join(filePath, CONTENT_FILE), function (err, data) {
            if (err) {
              return callback(err);
            }
            return callback(null, data);
          });
        },
        function (callback) {
          fs.readFile(path.join(filePath, METADATA_FILE), function (err, data) {
            if (err) {
              return callback(err);
            }
            callback(null, buildS3ObjectFromMetaDataFile(key, data));
          });
        }
      ], function (err, results) {
        if (err) {
          return done(erR);
        }
        return done(null, results[1], results[0]);
      });
    });
  };

  var getObjects = function (bucket, options, done) {
    var bucketPath = getBucketPath(bucket.name);
    var matches = [];
    var keys = utils.walk(bucketPath);
    var filteredKeys = _.filter(keys, function (file) {
      if (options.prefix) {
        var key = file.replace(bucketPath + '/', '');
        var match = (key.substring(0, options.prefix.length) === options.prefix);
        return match;
      }
      return true;
    });
    async.eachSeries(filteredKeys, function (key, callback) {
        fs.readFile(path.join(key, METADATA_FILE), function (err, data) {
          if (data) {
            matches.push(buildS3ObjectFromMetaDataFile(key.replace(bucketPath + '/', ''), data));
          }
          callback(null);
        });
      }, function () {
        done(null, matches);
      }
    );
  };

  var buildS3ObjectFromMetaDataFile = function (key, file) {
    var json = JSON.parse(file);
    var metaData = {
      key: key,
      md5: json.md5,
      contentType: json.contentType,
      size: json.size,
      modifiedDate: json.modifiedDate,
      creationDate: json.creationDate,
      customMetaData: json.customMetaData
    };
    return new S3Object(metaData);
  };

  var getCustomMetaData = function (headers) {
    var customMetaData = [];
    for (header in headers) {
      if (/^x-amz-meta-(.*)$/.test(header)) {
        customMetaData.push(header);
      }
    }
    return customMetaData;
  };

  var createMetaData = function (data, done) {
    var contentFile = data.contentFile,
        type = data.type,
        metaFile = data.metaFile,
        headers = data.headers;
    async.parallel([
      function (callback) {
        fs.stat(contentFile, function (err, stats) {
          if (err) {
            return callback(err);
          }
          return callback(null, {
            mtime: stats.mtime,
            ctime: stats.ctime
          });
        });
      },
      function (callback) {
        fs.readFile(contentFile, function (err, data) {
          return callback(null, {
            size: data.length,
            md5: md5(data)
          });
        });
      }
    ], function (err, results) {
      var metaData = {
        md5: results[1].md5,
        contentType: type,
        size: results[1].size,
        modifiedDate: results[0].mtime,
        creationDate: results[0].ctime,
        customMetadata: getCustomMetaData(headers)
      };
      fs.writeFile(metaFile, JSON.stringify(metaData), function (err) {
        return done(null, metaData);
      });
    });
  };

  var putObject = function (bucket, req, done) {
    var keyName = path.join(bucket.name, req.params.key);
    var dirName = path.join(rootDirectory, keyName);
    mkdirp.sync(dirName);
    var contentFile = path.join(dirName, CONTENT_FILE);
    var metaFile = path.join(dirName, METADATA_FILE);
    if (/^multipart\/form-data; boundary=.+$/.test(req.headers['content-type'])) {
      var file = req.files.file;
      var type = file.type;
      var key = req.params.key;
      var key = key.substr(key.lastIndexOf('/') + 1);
      fs.readFile(file.path, function (err, data) {
        if (err) {
          return done('Error reading file');
        }
        fs.writeFile(contentFile, data, function (err) {
          if (err) {
            debug('Error writing file', err);
            return done('Error writing file');
          }
          createMetaData({
            contentFile: contentFile,
            type: type,
            key: key,
            metaFile: metaFile,
            headers: req.headers
          }, function (err, metaData) {
            if (err) {
              return done('Error uploading file');
            }
            return done(null, new S3Object(metaData));
          });
        });
      });
    }
  };

  var deleteObject = function (bucket, key, done) {
    var keyPath = path.resolve(getBucketPath(bucket.name), key);
    async.map([path.join(keyPath, METADATA_FILE),
      path.join(keyPath, CONTENT_FILE)], fs.unlink, function (err) {
      if (err) {
        return done(err);
      }
      fs.rmdir(keyPath, function () {
        return done();
      });
    });
  };

  var getObjectExists = function (bucket, key, done) {
    var keyPath = path.resolve(getBucketPath(bucket.name), key);
    fs.stat(keyPath, function (err, file) {
      if (err || !file.isDirectory()) {
        return done('Object not found for ' + keyPath);
      }
      return done(null);
    });
  };

  return {
    getBuckets: getBuckets,
    getBucket: getBucket,
    putBucket: putBucket,
    deleteBucket: deleteBucket,
    getObjects: getObjects,
    getObject: getObject,
    putObject: putObject,
    getObjectExists: getObjectExists,
    deleteObject: deleteObject
  };
};
module.exports = FileStore;