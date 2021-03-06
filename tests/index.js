import 'es6-promise'; // for regenerator
import 'regenerator-runtime/runtime'; // only for tests, because async/await needs it

import BroccoliDependencyFunnel from '../';
import broccoli from 'broccoli';
import chai from 'chai';
import chaiFiles from 'chai-files';
import fixture from 'fixturify';
import fs from 'fs-extra';
import walkSync from 'walk-sync';
import path from 'path';

const { expect } = chai;
const { file } = chaiFiles;

chai.config.truncateThreshold = 1000;
chai.use(chaiFiles);

// Some filesystems dont have lower then 1s mtime resolution
async function fsTick() {
  return new Promise((resolve) => setTimeout(resolve, 1001));
}

// Helper to assert that two stats are equal, but only in the ways we care about.
// Helpful because atime is finicky.
function assertStatEqual(a, b) {
  expect(a.mtime.toString()).to.equal(b.mtime.toString());
  expect(a.mode).to.equal(b.mode);
  expect(a.size).to.equal(b.size);
}

// Helper to assert that a file did change. We really only care that mtime changed.
function assertStatChange(a, b) {
  expect(a.mtime.toString()).to.not.equal(b.mtime.toString());
}

describe('BroccoliDependencyFunnel', function() {
  this.timeout(5000);

  const input = 'tmp/fixture-input';
  let node, pipeline;

  beforeEach(function() {
    fs.mkdirpSync(input);
    fixture.writeSync(input, {
      'routes.js': 'import buildRoutes from "ember-engines/routes";import foo from "utils/foo";',
      'utils': {
        'foo.js': 'import derp from "./derp";export default {};',
        'derp.js': 'export default {};',
        'herp.js': 'export default {};'
      },
      'engine.js': 'import herp from "./utils/herp";'
    });
  });

  afterEach(function() {
    fs.removeSync(input);
    return pipeline.cleanup().then(function() {
      node = undefined;
      pipeline = undefined;
    });;
  });

  describe("build", function() {
    it('returns a tree of the dependency graph when using include', async function() {
      node = new BroccoliDependencyFunnel(input, {
        include: true,
        entry: 'routes.js',
        external: [ 'ember-engines/routes' ]
      });

      pipeline = new broccoli.Builder(node);

      const { directory } = await pipeline.build();

      const output = walkSync(directory);
      expect(output).to.deep.equal([ 'routes.js', 'utils/', 'utils/derp.js', 'utils/foo.js' ]);
    });

    it('returns a tree excluding the dependency graph when using exclude', async function() {
      node = new BroccoliDependencyFunnel(input, {
        exclude: true,
        entry: 'routes.js',
        external: [ 'ember-engines/routes' ]
      });

      pipeline = new broccoli.Builder(node);

      const { directory } = await pipeline.build();

      const output = walkSync(directory);
      expect(output).to.deep.equal([ 'engine.js', 'utils/', 'utils/herp.js' ]);
    });
  });

  describe('rebuild', function() {
    it('is stable on unchanged rebuild with include', async function() {
      node = new BroccoliDependencyFunnel(input, {
        include: true,
        entry: 'routes.js',
        external: [ 'ember-engines/routes' ]
      });

      pipeline = new broccoli.Builder(node);

      const { directory } = await pipeline.build();

      const beforeStat = fs.statSync(directory);

      await fsTick();
      await pipeline.build();

      const afterStat = fs.statSync(directory);
      assertStatEqual(beforeStat, afterStat);
    });

    it('is stable on unchanged rebuild with exclude', async function() {
      node = new BroccoliDependencyFunnel(input, {
        exclude: true,
        entry: 'routes.js',
        external: [ 'ember-engines/routes' ]
      });

      pipeline = new broccoli.Builder(node);

      const { directory } = await pipeline.build();

      const beforeStat = fs.statSync(directory);

      await fsTick();
      await pipeline.build();

      const afterStat = fs.statSync(directory);
      assertStatEqual(beforeStat, afterStat);
    });

    it('is stable when changes occur outside dep graph and using include', async function() {
      node = new BroccoliDependencyFunnel(input, {
        include: true,
        entry: 'routes.js',
        external: [ 'ember-engines/routes' ]
      });

      pipeline = new broccoli.Builder(node);
      const { directory } = await pipeline.build();

      const beforeStat = fs.statSync(directory);
      await fsTick();

      fixture.writeSync(input, {
        'engine.js': ''
      });

      await pipeline.build();

      const afterStat = fs.statSync(directory);
      assertStatEqual(beforeStat, afterStat, 'stable rebuild when modifying file NOT in dep graph');
    });

    it('updates when changes occur in dep graph and using include', async function() {
      node = new BroccoliDependencyFunnel(input, {
        include: true,
        entry: 'routes.js',
        external: [ 'ember-engines/routes' ]
      });

      pipeline = new broccoli.Builder(node);
      const { directory } = await pipeline.build();

      const beforeStat = fs.statSync(directory);

      let output = walkSync(directory);
      expect(output).to.deep.equal([ 'routes.js', 'utils/', 'utils/derp.js', 'utils/foo.js' ]);

      await fsTick();

      fixture.writeSync(input, {
        'routes.js': 'import herp from "utils/herp";'
      });

      await pipeline.build();

      const afterStat = fs.statSync(directory);
      assertStatChange(beforeStat, afterStat, 'instable rebuild when modifying file in dep graph');

      output = walkSync(directory);
      expect(output).to.deep.equal([ 'routes.js', 'utils/', 'utils/herp.js' ]);
    });

    it('updates when changes occur outside dep graph and using exclude', async function() {
      node = new BroccoliDependencyFunnel(input, {
        exclude: true,
        entry: 'routes.js',
        external: [ 'ember-engines/routes' ]
      });

      pipeline = new broccoli.Builder(node);
      const { directory } = await pipeline.build();

      const engineStat = fs.statSync(directory + '/engine.js');
      const routesStat = fs.statSync(directory + '/utils/herp.js');

      await fsTick();

      fixture.writeSync(input, {
        'engine.js': ''
      });

      await pipeline.build();

      const engineRebuildStat = fs.statSync(directory + '/engine.js');
      assertStatChange(engineStat, engineRebuildStat, 'engine.js changed');

      let routesRebuildStat = fs.statSync(directory + '/utils/herp.js');
      assertStatEqual(routesStat, routesRebuildStat, 'routes.js unchanged');

      await fsTick();

      fs.unlink(path.join(input, 'engine.js'));

      await pipeline.build();

      expect(fs.existsSync(directory + '/engine.js')).to.be.not.ok;

      routesRebuildStat = fs.statSync(directory + '/utils/herp.js');
      assertStatEqual(routesStat, routesRebuildStat, 'routes.js unchanged second time');
    });

    it('updates when changes occur in dep graph and using exclude', async function() {
      node = new BroccoliDependencyFunnel(input, {
        exclude: true,
        entry: 'routes.js',
        external: [ 'ember-engines/routes' ]
      });

      pipeline = new broccoli.Builder(node);
      const { directory } = await pipeline.build();

      const buildStat = fs.statSync(directory);

      let output = walkSync(directory);
      expect(output).to.deep.equal([ 'engine.js', 'utils/', 'utils/herp.js' ]);

      await fsTick();

      fixture.writeSync(input, {
        'routes.js': 'import herp from "utils/herp";'
      });

      await pipeline.build();

      const rebuildStat = fs.statSync(directory);
      assertStatChange(rebuildStat, buildStat, 'instable rebuild when modifying file in dep graph');

      output = walkSync(directory);
      expect(output).to.deep.equal([ 'engine.js', 'utils/', 'utils/derp.js', 'utils/foo.js' ]);
    });
  });
});
