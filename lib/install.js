var Promise = require('./promise')
var debug = require('debug')('pnpm:install')
var npa = require('npm-package-arg')
var join = require('path').join
var mkdirp = require('./mkdirp')
var fetch = require('./fetch')
var resolve = require('./resolve')
var getUuid = require('node-uuid')
var symlink = require('./force_symlink')
var relSymlink = require('./rel_symlink')
var linkBins = require('./install/link_bins')
var fs = require('mz/fs')

/*
 * Installs a package.
 *
 *     install(ctx, 'rimraf@2', './node_modules')
 *
 * Parameters:
 *
 * - `ctx` (Object) - the context.
 *   - `root` (String) - root path of the package.
 *   - `tmp` (String) - temp dir
 *   - `log` (Function) - logger
 *
 * What it does:
 *
 * - resolve() - resolve from registry.npmjs.org
 * - fetch() - download tarball into node_modules/.tmp/{uuid}
 * - recurse into its dependencies
 * - run postinstall hooks
 * - move .tmp/{uuid} into node_modules/{name}@{version}
 * - symlink node_modules/{name}
 * - symlink bins
 */

module.exports = function install (ctx, pkg, modules, options) {
  var installAll = require('./install_multiple')
  debug('installing ' + pkg)

  var depth = (options && options.depth || 0)
  var pkgSpec = npa(pkg) // { raw, name, scope, type, spec, rawSpec }
  var pkgData  // { name, version, ... }
  var name     // 'lodash'
  var fullname // 'lodash@4.0.0'
  var dist     // { shasum, tarball }
  var log = ctx.log(pkgSpec) // function

  var paths = {
    store: join(ctx.root, 'node_modules', '.store'),
    tmp: join(ctx.root, 'node_modules', '.tmp', getUuid()),
    target: undefined // store + '/lodash@4.0.0'
  }

  return fs.stat(join(modules, pkgSpec.name, 'package.json'))
    .catch(err => {
      if (err.code !== 'ENOENT') throw err
      return resolve(pkgSpec)
        .then(set)
        .then(_ => log('resolved', pkgData))
        .then(_ => fs.stat(join(paths.target, 'package.json'))) // todo: verify version?
        .catch(err => {
          if (err.code !== 'ENOENT') throw err
          if (isLocked(ctx, paths.target)) return Promise.resolve()
          return Promise.resolve()
          .then(_ => lock(ctx, paths.target))
          .then(_ => log('downloading'))
          .then(_ => mkdirp(paths.store))
          .then(_ => mkdirp(paths.tmp))
          .then(_ => fetch(paths.tmp, dist.tarball, dist.shasum, log))
          .then(_ => linkBins(modules, paths.tmp, paths.target))
          .then(_ => log('dependencies'))
          .then(_ => installAll(ctx,
            pkgData.dependencies,
            join(paths.tmp, 'node_modules'),
            { depth: depth + 1 }))
          .then(_ => symlinkSelf(paths.tmp, pkgSpec, depth))
          .then(_ => fs.rename(paths.tmp, paths.target))
          .then(_ => unlock(ctx, paths.target))
        })
        .then(_ => mkdirp(modules))
        .then(_ => symlinkToModules(paths.target, pkgSpec, modules))
    })
    .then(_ => log('done'))
    .catch(err => {
      log('error', err)
      throw err
    })

  // set metadata as fetched from resolve()
  function set (res) {
    pkgData = res
    fullname = '' + res.name.replace('/', '!') + '@' + res.version
    paths.target = join(paths.store, fullname)
    name = res.name
    dist = res.dist
  }
}

function lock (ctx, path) {
  if (!ctx.lock) ctx.lock = {}
  ctx.lock[path] = true
}

function unlock (ctx, path) {
  if (ctx.lock) ctx.lock[path] = undefined
}

function isLocked (ctx, path) {
  return ctx.lock && ctx.lock[path]
}

/*
 * Symlink a package into its own node_modules. this way, babel-runtime@5 can
 * require('babel-runtime') within itself.
 */

function symlinkSelf (target, pkg, depth) {
  debug('symlinkSelf %s', pkg.name)
  if (depth === 0) {
    return Promise.resolve()
  } else {
    return mkdirp(join(target, 'node_modules'))
      .then(_ => symlink(
        join('..'),
        join(target, 'node_modules', pkg.name)))
  }
}

/*
 * Perform the final symlinking of ./.store/x@1.0.0 -> ./x.
 *
 *     target = '/node_modules/.store/lodash@4.0.0'
 *     name = 'lodash'
 *     modules = './node_modules'
 *     symlinkToModules(fullname, name, modules, 0)
 */

function symlinkToModules (target, pkg, modules) {
  // lodash -> .store/lodash@4.0.0
  // .store/foo@1.0.0/node_modules/lodash -> ../../../.store/lodash@4.0.0
  // .tmp/01234567890/node_modules/lodash -> ../../../.store/lodash@4.0.0
  if (pkg.scope) {
    debug('make scope dir', pkg.scope)
    return mkdirp(join(modules, pkg.scope))
      .then(relSymlink(target, join(modules, pkg.name)))
  }

  return relSymlink(target, join(modules, pkg.name))
}
