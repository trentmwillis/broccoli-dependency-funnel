import fs from 'fs';
import path from 'path-posix';
import Plugin from 'broccoli-plugin';
import FSTree from 'fs-tree-diff';
import Entry from 'fs-tree-diff/lib/entry';
import existsSync from 'exists-sync';
import heimdall from 'heimdalljs';
import { default as _logger } from 'heimdalljs-logger';
import rimraf from 'rimraf';
import { rollup } from 'rollup';
import { moduleResolve as amdNameResolver } from 'amd-name-resolver';

import copyFile from './utils/copy-file';
import existsStat from './utils/exists-stat';
import filterDirectory from './utils/filter-directory';

const logger = _logger('broccoli-dependency-funnel');

export default class BroccoliDependencyFunnel extends Plugin {
  constructor(node, options = {}) {
    super([node], {
      name: options.name,
      annotation: options.annotation,
      persistentOutput: true
    });

    if (!(options.include ^ options.exclude)) {
      throw new Error('Must specify exactly one of `include` or `exclude`.');
    }

    // We only need 'include', because we know that if we're not including,
    // we're excluding.
    this.include = !!options.include;

    this.entry = options.entry;
    this.external = options.external;

    // An array and FSTree, respectively, representing the dependency graph of the
    // entry point or the non-dependency graph.
    this._depGraph = undefined;
    this._depGraphTree = undefined;
    this._nonDepGraph = undefined;
    this._nonDepGraphTree = undefined;
  }

  build() {
    const inputPath = this.inputPaths[0];

    // Check for changes in the files included in the dependency graph
    if (this._depGraph) {
      const incomingDepGraphTree = this._getFSTree(this._depGraph);
      const depGraphPatch = this._depGraphTree.calculatePatch(incomingDepGraphTree);
      const hasDepGraphChanges = depGraphPatch.length !== 0;

      if (!hasDepGraphChanges) {
        return this._buildNonDepGraphChanges();
      }
    }

    const entryExists = existsSync(path.join(inputPath, this.entry));
    if (!entryExists) {
      if (!this.include) {
        const modules = fs.readdirSync(inputPath);
        this._copy(modules);
      }

      return;
    }

    const modules = [];
    const rollupOptions = this._getRollupOptions(modules);
    return rollup(rollupOptions).then(() => this._copyDepGraph(modules));
  }

  /**
   * Copies a series of files or directories forward.
   *
   * @private
   * @param {Array<String>}
   * @return {Void}
   */
  _copy(inodes) {
    const inputPath = this.inputPaths[0];
    const outputPath = this.outputPath;

    for (let i = 0; i < inodes.length; i++) {
      const module = inodes[i];
      copyFile(path.join(inputPath, module), path.join(outputPath, module));
    }
  }

  /**
   * Builds changes not in the dependency graph by calculating a patch and
   * applying it. Only does work when in 'exclude' mode.
   *
   * @private
   * @return {Void}
   */
  _buildNonDepGraphChanges() {
    const incomingNonDepGraphTree = this._getFSTree(this._nonDepGraph);
    const nonDepGraphPatch = this._nonDepGraphTree.calculatePatch(incomingNonDepGraphTree);
    const hasNonDepGraphChanges = nonDepGraphPatch.length !== 0;

    if (!hasNonDepGraphChanges) {
      return;
    }

    // Copy forward changes not in the dependency graph when using exclude
    if (!this.include) {
      FSTree.applyPatch(this.inputPaths[0], this.outputPath, nonDepGraphPatch);
    }
  }

  /**
   * Constructs an FSTree from the passed in paths.
   *
   * @param {Array<String>} paths
   * @return {FSTree}
   */
  _getFSTree(paths) {
    const inputPath = this.inputPaths[0];
    const entries = paths.map(function(entryPath) {
      const absolutePath = path.join(inputPath, entryPath);
      const stat = existsStat(absolutePath);

      if (!stat) {
        return;
      }

      return Entry.fromStat(entryPath, stat);
    }).filter(Boolean);

    return FSTree.fromEntries(entries);
  }

  /**
   * Copies modules forward as part of the dependency graph if using 'include'
   * or copies all other modules in the input if using 'exclude'.
   *
   * @private
   * @param {Array<String>} modules
   * @return {Void}
   */
  _copyDepGraph(modules) {
    const inputPath = this.inputPaths[0];

    this._depGraph = modules.sort();
    this._nonDepGraph = filterDirectory(inputPath, '', (module) => modules.indexOf(module) === -1).sort();

    rimraf.sync(this.outputPath);

    const toCopy = this.include ? this._depGraph : this._nonDepGraph;
    this._copy(toCopy);

    this._depGraphTree = this._getFSTree(this._depGraph);
    this._nonDepGraphTree = this._getFSTree(this._nonDepGraph);
  }

  /**
   * Constructs an options hash to be used with Rollup. It accepts a reference
   * to an array to collect a list of modules walked in the dependency graph.
   *
   * @private
   * @param {Array<String>} modules
   * @return {Object}
   */
  _getRollupOptions(modules) {
    const inputPath = this.inputPaths[0];
    return {
      entry: this.entry,
      external: this.external || [],
      dest: 'foo.js',
      plugins: [
        {
          resolveId(importee, importer) {
            // This will only ever be the entry point.
            if (!importer) {
              const moduleName = importee.replace(inputPath, '');
              modules.push(moduleName);
              return path.join(inputPath, importee);
            }

            // Link in the global paths.
            const moduleName = amdNameResolver(importee, importer).replace(inputPath, '').replace(/^\//, '');
            const modulePath = path.join(inputPath, moduleName + '.js');
            if (existsSync(modulePath)) {
              modules.push(moduleName + '.js');
              return modulePath;
            }
          }
        }
      ]
    };
  }
}
