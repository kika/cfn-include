var _ = require('lodash'),
  url = require('url'),
  path = require('path'),
  Promise = require('bluebird'),
  readFile = Promise.promisify(require('fs').readFile),
  pathParse = require('path-parse'),
  request = Promise.promisify(require('request')),
  AWS = require('aws-sdk-proxy'),
  s3 = new AWS.S3(),
  jsonlint = require('jsonlint'),
  jsmin = require('jsmin').jsmin,
  yaml = require('js-yaml'),
  yamlSchema = require('./lib/schema'),
  jmespath = require('jmespath');
  parseLocation = require('./lib/parselocation');


module.exports = function(options) {
  var template = options.template,
    base = parseLocation(options.url),
    scope = options.scope || {};
  if (base.relative) throw "url cannot be relative";
  template = _.isUndefined(template) ? include(base, scope, options.url) : template;
  return Promise.resolve(template).then(function(template) {
    return recurse(base, scope, template);
  });
}

function recurse(base, scope, object) {
  scope = _.clone(scope);
  if (_.isArray(object)) return Promise.all(object.map(_.bind(recurse, this, base, scope)));
  else if (_.isPlainObject(object)) {
    if (object["Fn::Map"]) {
      var args = object["Fn::Map"],
        list = args[0],
        placeholder = args[1],
        body = args[args.length - 1];
      if (args.length === 2) placeholder = '_';
      return recurse(base, scope, list).map(function(replace) {
        scope = _.clone(scope);
        scope[placeholder] = replace;
        var replaced = findAndReplace(scope, _.cloneDeep(body));
        return recurse(base, scope, replaced);
      });
    } else if (object["Fn::Include"]) {
      return include(base, scope, object["Fn::Include"]).then(function(json) {
        if(!_.isPlainObject(json)) return json;
        delete object["Fn::Include"];
        _.defaults(object, json);
        return object;
      }).then(_.bind(findAndReplace, this, scope)).then(_.bind(recurse, this, base, scope));
    } else if (object["Fn::Flatten"]) {
      return recurse(base, scope, object["Fn::Flatten"]).then(function(json) {
        return _.flatten(json);
      });
    } else if (object["Fn::Merge"]) {
      return recurse(base, scope, object["Fn::Merge"]).then(function(json) {
        return _.merge.apply(_, json);
      });
    } else {
      return Promise.props(_.mapValues(object, _.bind(recurse, this, base, scope)))
    }
  } else if(_.isUndefined(object)) {
    return null;
  } else {
    return object;
  }
}

function findAndReplace(scope, object) {
  _.forEach(scope, function(replace, find) {
    var regex = new RegExp('\\${' + find + '}', 'g');
    if (_.isString(object) && object === find) {
      object = replace;
    } else if (_.isString(object) && find !== '_' && object.match(regex)) {
      object = object.replace(regex, replace);
    } else if (_.isArray(object)) {
      object = object.map(_.bind(findAndReplace, this, scope));
    } else if (_.isPlainObject(object)) {
      object = _.mapKeys(object, function(value, key) {
        return findAndReplace(scope, key);
      });
      _.keys(object).forEach(function(key) {
        if (key === 'Fn::Map') return;
        object[key] = findAndReplace(scope, object[key]);
      });
      return object;
      return _.mapValues(object, _.bind(findAndReplace, this, scope));
    } else {
      return object;
    }
  });
  return object;
}

function interpolate(lines, context) {
  return lines.map(function(line) {
    var parts = [];
    line.split(/({{\w+?}})/g).map(function(line) {
      var match = line.match(/^{{(\w+)}}$/),
        value = match ? context[match[1]] : undefined;
      if (!match) return line;
      else if (_.isUndefined(value)) {
        return ''
      } else {
        return value;
      }
    }).forEach(function(part) {
      var last = parts[parts.length - 1];
      if (_.isPlainObject(part) || _.isPlainObject(last) || !parts.length) {
        parts.push(part);
      } else if (parts.length) {
        parts[parts.length - 1] = last + part;
      }
    });
    return parts.filter(function(part) {
      return part !== '';
    });
  });
}

function include(base, scope, args) {
  args = _.defaults(_.isPlainObject(args) ? args : {
    location: args,
  }, { type: 'json' });
  var body, absolute, location = parseLocation(args.location);
  if (!_.isEmpty(location) && !location.protocol) location.protocol = base.protocol;
  if (location.protocol === 'file') {
    absolute = location.relative ? path.join(path.dirname(base.path), location.host, location.path || '') : [location.host, location.path].join('');
    body = readFile(absolute).call('toString');
    absolute = location.protocol + '://' + absolute;
  } else if (location.protocol === 's3') {
    var basedir = pathParse(base.path).dir;
    var bucket = location.relative ? base.host : location.host,
      key = location.relative ? url.resolve(basedir + '/', location.raw) : location.path;
    key = key.replace(/^\//, '');
    absolute = location.protocol + '://' + [bucket, key].join('/');
    body = Promise.promisify(s3.getObject).call(s3, {
      Bucket: bucket,
      Key: key,
    }).get('Body').call('toString');
  } else if (location.protocol && location.protocol.match(/^https?$/)) {
    var basepath = pathParse(base.path).dir + '/';
    absolute = location.relative ? url.resolve(location.protocol + '://' + base.host + basepath, location.raw) : location.raw;
    body = request({
      url: absolute,
      followRedirect: false,
      gzip: true,
      strictSSL: true,
    }).get('body').call('toString');
  }
  if(body) body.catch(bail);
  if (args.type === 'json') {
    return body.then(function(res) { return yaml.safeLoad(res, { schema: yamlSchema }) }).catch(function(yamlErr) {
      return body.then(jsmin).then(JSON.parse).catch(function(jsonErr) {
       var err = new Error([yamlErr, jsonErr]);
       err.name = 'SyntaxError';
       throw err;
      });
    }).then(function(template) {
      if (args.query) {
        template = jmespath.search(template, args.query);
      }
      return module.exports({
        template: _.isUndefined(template) ? null : template,
        url: absolute,
        scope: scope,
      }).return(template);
    });
  } else if (args.type === 'api') {
    var handler = require('./lib/include/api');
    return handler(args);
  } else if (args.type === 'string') {
    return body;
  } else if (args.type === 'literal') {
    return body.then(function(template) {
      var lines = JSONifyString(template);
      if (_.isPlainObject(args.context)) {
        lines = interpolate(lines, args.context);
      }
      return {
        'Fn::Join': ['', _.flatten(lines)]
      };
    });
  }
}

function JSONifyString(string) {
  var lines = [],
    split = string.toString().split(/(\r?\n)/);
  split.forEach(function(line, idx) {
    if (idx % 2) {
      lines[(idx - 1) / 2] = lines[(idx - 1) / 2] + line;
    } else {
      lines.push(line);
    }
  });
  return lines;
}

function bail(err) {
  console.error(err.toString());
  process.exit(1);
}
