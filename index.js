'use strict';

const { renderToString } = require('react-dom/server');
const React = require('react');
const fs = require('fs');
const { createRequire } = require('module');
const { pathToFileURL, fileURLToPath } = require('url');
const crypto = require('crypto');

let babelRegistered = false;
function ensureBabelRegister(filePath) {
  if (babelRegistered) return;
  const localRequire = createRequire(filePath);
  let babelRegister;
  try {
    babelRegister = localRequire('@babel/register');
  } catch (errLocal) {
    try {
      babelRegister = require('@babel/register');
    } catch (errGlobal) {
      throw new Error(
        'Failed to set up Babel register: please install @babel/register (and babel plugins) in your Hexo project or renderer package.'
      );
    }
  }
  babelRegister({
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    plugins: [
      '@babel/plugin-syntax-dynamic-import',
      ['@babel/plugin-transform-react-jsx', {
        runtime: 'automatic'
      }]
    ],
    ignore: [/node_modules/]
  });
  babelRegistered = true;
}

// Create a require for loading ESM modules
let compile;
let compileLoaded = false;

async function loadCompile() {
  if (!compileLoaded) {
    try {
      // Try to load @mdx-js/mdx - it may be CJS or ESM depending on the environment
      try {
        // First try: dynamic import with proper error handling
        const mdxModule = await (async () => {
          try {
            return await import('@mdx-js/mdx');
          } catch (err) {
            // If dynamic import fails, this might be a require context issue
            // Return null to trigger fallback
            return null;
          }
        })();
        
        if (mdxModule) {
          compile = mdxModule.compile;
        } else {
          throw new Error('Could not load @mdx-js/mdx via dynamic import');
        }
      } catch (err) {
        // Fallback: try to require it directly (in case it's been transpiled)
        compile = require('@mdx-js/mdx').compile;
      }
      compileLoaded = true;
    } catch (err) {
      throw new Error(`Failed to load @mdx-js/mdx: ${err.message}`);
    }
  }
}

/**
 * MDX Renderer for Hexo
 * 
 * This renderer allows you to use MDX files in your Hexo blog.
 * MDX is markdown with JSX support, allowing you to embed React components.
 */

/**
 * Render MDX content to HTML
 * @param {Object} data - The data object containing MDX content
 * @param {string} data.text - The MDX content to render
 * @param {string} data.path - The file path (for error reporting)
 * @returns {Promise<string>} The rendered HTML
 */
async function mdxRenderer(data) {
  const { text, path: filePath } = data;
  
  // Initialize dependencies Set for tracking imported component files
  if (!data.dependencies) {
    data.dependencies = new Set();
  }
  
  try {
    // Ensure Babel can handle JSX/TS imports from MDX files (e.g., local components).
    ensureBabelRegister(filePath);

    // Ensure compile function is loaded
    await loadCompile();

    // Stable per-file hash to namespace hydration ids and bundles
    const fileHash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 8);
    
    // Read the original file directly to bypass Hexo's template processing
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      // If reading fails, fall back to the provided text
      content = text;
    }
    
    // Strip YAML front matter if present
    const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
    const match = content.match(frontMatterRegex);
    
    if (match) {
      // Remove front matter from content
      content = content.slice(match[0].length);
    }
    
    // Compile MDX to JavaScript with automatic JSX runtime
    // Use outputFormat: 'function-body' and development: true to get jsxDEV calls
    // baseUrl needs trailing slash for proper relative path resolution
    const filePathDir = path.dirname(filePath);
    const compiled = await compile(content, {
      outputFormat: 'function-body',
      development: true,
      baseUrl: pathToFileURL(filePathDir + '/'),
      // remarkRehypeOptions for markdown processing
      remarkRehypeOptions: {
        allowDangerousHtml: true
      }
    });

    // Create a function from the compiled code
    const code = String(compiled);
    
    // When development: true, the compiled code uses jsxDEV from react/jsx-dev-runtime
    const jsxDevRuntime = require('react/jsx-dev-runtime');
    
    // Replace dynamic imports with a shim that resolves relative to the MDX file and uses require to stay in CJS.
    const toModuleNamespace = (mod) => {
      // If it already looks like an ES module with a default export, return as-is
      if (mod && typeof mod === 'object' && 'default' in mod) return mod;
      // For CJS modules, wrap as ES module: spread first, then set default to ensure it's not overwritten
      if (mod && typeof mod === 'object') {
        return { ...mod, default: mod };
      }
      // For primitive or function values, just set as default
      return { default: mod };
    };
    // Collect components used so we can hydrate them client-side
    const componentsForHydration = [];
    const dynamicImport = (specifier) => {
      const asString = String(specifier);
      const req = createRequire(filePath);

      // Resolve a filesystem path for this specifier
      // Use directory of filePath since _resolveDynamicMdxSpecifier uses baseUrl (directory)
      const filePathDir = path.dirname(filePath);
      let fsPath;
      try {
        if (asString.startsWith('file://')) {
          fsPath = fileURLToPath(asString);
        } else {
          const resolvedUrl = new URL(asString, pathToFileURL(filePathDir + '/'));
          if (resolvedUrl.protocol === 'file:') {
            fsPath = fileURLToPath(resolvedUrl);
          }
        }
      } catch (e) {
        // ignore - will try bare require
      }

      // Create a placeholder component for server-side rendering
      const placeholderId = `mdx-cmp-${fileHash}-${componentsForHydration.length + 1}`;
      const Placeholder = (props) => {
        return React.createElement('div', { 'data-mdx-component': placeholderId });
      };

      // Record mapping for hydration bundle (use filesystem path when available, otherwise the original specifier)
      componentsForHydration.push({ id: placeholderId, spec: fsPath || asString });

      // Register component file as a dependency so Hexo watches it for changes
      if (fsPath && data.dependencies) {
        data.dependencies.add(fsPath);
      }

      // Return an ES-like namespace with default export set to placeholder
      return Promise.resolve({ default: Placeholder });
    };

    // Swap all occurrences of 'import(' (awaited or not) with our shim to avoid vm dynamic import callbacks.
    const patchedCode = code.replace(/import\(/g, 'dynamicImport(');
    const fn = new Function('jsxRuntime', 'dynamicImport', `return (async () => { ${patchedCode} })();`);
    const mdxModule = await fn(jsxDevRuntime, dynamicImport);
    
    // The result has a default export which is the MDX component
    const MDXContent = mdxModule.default;
    
    // Render the component to static HTML
    const html = renderToString(
      React.createElement(MDXContent, {})
    );

    // If there are components to hydrate, generate a client bundle using esbuild (if available)
    let finalHtml = html;
    if (componentsForHydration.length > 0) {
      try {
        const esbuild = require('esbuild');
        const os = require('os');
        const tmpdir = os.tmpdir();
        const hash = fileHash;
        const outName = `mdx-hydrate-${hash}.js`;
        // Output compiled hydration bundle and temporary entry into the site's public directory
        const projectRoot = hexo && hexo.base_dir ? hexo.base_dir : process.cwd();
        const publicDir = (hexo && hexo.public_dir) ? hexo.public_dir : require('path').join(projectRoot, 'public');
        const outDir = require('path').join(publicDir, 'assets');
        const entryPath = require('path').join(publicDir, '.hexo-mdx-entry', `mdx-entry-${hash}.mjs`);

        const imports = componentsForHydration.map((c, i) => {
          // Convert absolute path to relative path from entry directory
          let importPath = c.spec;
          if (require('path').isAbsolute(importPath)) {
            importPath = require('path').relative(require('path').dirname(entryPath), importPath);
          }
          // Normalize slashes for JS import
          importPath = importPath.replace(/\\/g, '/');
          // Ensure relative imports start with ./ or ../
          if (!importPath.startsWith('.')) {
            importPath = './' + importPath;
          }
          return `import C${i} from ${JSON.stringify(importPath)};`;
        }).join('\n');

        const mapping = componentsForHydration.map((c, i) => `  '${c.id}': C${i}`).join(',\n');

        const entrySource = `import React from 'react';\nimport { hydrateRoot } from 'react-dom/client';\n\n// Make React available globally for imported components\nwindow.React = React;\n\n${imports}\n\nconst mapping = {\n${mapping}\n};\n\nObject.keys(mapping).forEach(id => {\n  const Comp = mapping[id];\n  const el = document.querySelector('[data-mdx-component="'+id+'"]');\n  if (el) {\n    hydrateRoot(el, React.createElement(Comp, {}));\n  }\n});\n`;

        require('fs').mkdirSync(require('path').dirname(entryPath), { recursive: true });
        require('fs').writeFileSync(entryPath, entrySource, 'utf8');
        require('fs').mkdirSync(outDir, { recursive: true });

        esbuild.buildSync({
          entryPoints: [entryPath],
          bundle: true,
          format: 'esm',
          outfile: require('path').join(outDir, outName),
          platform: 'browser',
          jsx: 'transform',
          jsxFactory: 'React.createElement',
          jsxFragment: 'React.Fragment',
          minify: false,
          absWorkingDir: process.cwd(),
          loader: { '.jsx': 'jsx', '.js': 'js', '.mjs': 'js' }
        });

        // Hydration bundle is placed under /assets in the public dir
        finalHtml = `<div id="mdx-root-${hash}">${html}</div><script type="module" src="/assets/${outName}"></script>`;
      } catch (err) {
        console.error('MDX hydration bundle failed:', err.message);
      }
    }
    
    return finalHtml;
  } catch (err) {
    // Provide more detailed error information
    const errorMsg = `MDX compilation failed for ${filePath}: ${err.message}`;
    console.error(errorMsg);
    console.error('Full error stack:');
    console.error(err.stack);
    if (err.position) {
      console.error(`Error at line ${err.position.start.line}, column ${err.position.start.column}`);
    }
    throw new Error(errorMsg);
  }
}

/**
 * Register the MDX renderer with Hexo
 * Note: Using disableNunjucks: true to prevent template processing of {{ }} syntax
 */
const path = require('path');
const chokidar = require('chokidar');
const componentDependencies = new Map(); // Map of component path -> Set of MDX files that import it

// Bundle the entry file with esbuild to create the hydration client bundle
function bundleEntryToPublic() {
  try {
    const esbuild = require('esbuild');
    const crypto = require('crypto');
    const projectRoot = hexo && hexo.base_dir ? hexo.base_dir : process.cwd();
    const publicDir = (hexo && hexo.public_dir) ? hexo.public_dir : path.join(projectRoot, 'public');
    
    // Clear require cache for components before bundling to ensure fresh imports
    Object.keys(require.cache).forEach(key => {
      if (key.includes('source/components') || key.includes('source\\components')) {
        delete require.cache[key];
      }
    });
    
    // Find all entry files in public/.hexo-mdx-entry and bundle each one
    const entryDir = path.join(publicDir, '.hexo-mdx-entry');
    if (!fs.existsSync(entryDir)) {
      return; // No entry generated, skip bundling
    }
    
    // Get all entry files
    let entryFiles = [];
    try {
      const files = fs.readdirSync(entryDir);
      entryFiles = files.filter(f => f.startsWith('mdx-entry-') && f.endsWith('.mjs'));
    } catch (e) {
      return; // Error reading entry dir, skip
    }
    
    if (entryFiles.length === 0) return;
    
    const outDir = path.join(publicDir, 'assets');
    fs.mkdirSync(outDir, { recursive: true });
    
    // Bundle each entry file individually
    entryFiles.forEach(entryFile => {
      const entryPath = path.join(entryDir, entryFile);
      const hash = entryFile.match(/mdx-entry-([a-f0-9]+)/)?.[1] || 'unknown';
      const outName = `mdx-hydrate-${hash}.js`;
      
      try {
        esbuild.buildSync({
          entryPoints: [entryPath],
          bundle: true,
          format: 'iife',
          outfile: path.join(outDir, outName),
          platform: 'browser',
          target: 'es2017',
          minify: false,
          absWorkingDir: process.cwd(),
          loader: { '.jsx': 'jsx', '.js': 'js', '.mjs': 'js' },
          jsx: 'automatic'
        });
        console.log(`INFO  ✓ Bundled entry to ${path.join(outDir, outName)}`);
      } catch (err) {
        console.warn(`INFO  Bundle error for ${entryFile}: ${err.message}`);
      }
    });
  } catch (err) {
    // Silently skip if esbuild is unavailable
  }
}

// Bundle a single entry by its MDX file hash (targets only one output)
function bundleEntryByHash(hash) {
  try {
    const esbuild = require('esbuild');
    const projectRoot = hexo && hexo.base_dir ? hexo.base_dir : process.cwd();
    const publicDir = (hexo && hexo.public_dir) ? hexo.public_dir : path.join(projectRoot, 'public');
    const entryPath = path.join(publicDir, '.hexo-mdx-entry', `mdx-entry-${hash}.mjs`);
    const outDir = path.join(publicDir, 'assets');
    const outName = `mdx-hydrate-${hash}.js`;

    if (!fs.existsSync(entryPath)) {
      return; // No entry for this hash yet
    }

    fs.mkdirSync(outDir, { recursive: true });
    esbuild.buildSync({
      entryPoints: [entryPath],
      bundle: true,
      format: 'iife',
      outfile: path.join(outDir, outName),
      platform: 'browser',
      target: 'es2017',
      minify: false,
      absWorkingDir: process.cwd(),
      loader: { '.jsx': 'jsx', '.js': 'js', '.mjs': 'js' },
      jsx: 'automatic'
    });
    console.log(`INFO  ✓ Bundled entry to ${path.join(outDir, outName)}`);
  } catch (err) {
    console.warn(`INFO  Bundle error for hash ${hash}: ${err && err.message}`);
  }
}

// Persist component -> [mdxFiles] mapping into the public dir so it ships with the site
function saveComponentPathJson() {
  try {
    const projectRoot = hexo && hexo.base_dir ? hexo.base_dir : process.cwd();
    const publicDir = (hexo && hexo.public_dir) ? hexo.public_dir : path.join(projectRoot, 'public');
    const publicOut = path.join(publicDir, 'hexo-renderer-mdx.component-path.json');
    const obj = {};
    componentDependencies.forEach((mdxSet, compPath) => {
      try {
        obj[compPath] = Array.from(mdxSet);
      } catch (e) {
        obj[compPath] = [];
      }
    });
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(publicOut, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.warn('Could not write component-path JSON:', err && err.message);
  }
}

// Wrap renderer to track component dependencies
const originalMdxRenderer = mdxRenderer;
async function mdxRendererWithTracking(data) {
  const result = await originalMdxRenderer(data);
  
  // Track which components this MDX file depends on
  if (data.dependencies && data.dependencies.size > 0) {
    data.dependencies.forEach(componentPath => {
      if (!componentDependencies.has(componentPath)) {
        componentDependencies.set(componentPath, new Set());
      }
      componentDependencies.get(componentPath).add(data.path);
    });
    // Persist mapping to JSON so it's available across runs and survives hexo clean
    try {
      saveComponentPathJson();
    } catch (e) {
      // ignore
    }
  }
  
  return result;
}

hexo.extend.renderer.register('mdx', 'html', mdxRendererWithTracking, {
  disableNunjucks: true
});

/**
 * Watch component files and trigger full site regeneration when they change
 */
let mdxComponentWatcher = null;
// Only register watcher in real Hexo server runs
if (
  hexo &&
  hexo.extend &&
  hexo.extend.filter &&
  typeof hexo.extend.filter.register === 'function' &&
  hexo.env && hexo.env.cmd === 'server'
) {
hexo.extend.filter.register('after_init', function() {
  // Set up file watcher for component paths from the JSON mapping
  const sourceDir = path.join(hexo.source_dir, 'components');
  const projectRoot = hexo && hexo.base_dir ? hexo.base_dir : process.cwd();
  const componentPathJsonPath = path.join(projectRoot, 'hexo-renderer-mdx.component-path.json');
  
  // Only initialize the persistent watcher during `hexo server` runs.
  // For other commands (clean/generate), skip watcher to allow the process to exit.
  if (!hexo || !hexo.env || hexo.env.cmd !== 'server') {
    return;
  }

  // Function to read component paths from JSON and extract keys
  function getComponentPathsFromJson() {
    try {
      if (fs.existsSync(componentPathJsonPath)) {
        const mapping = JSON.parse(fs.readFileSync(componentPathJsonPath, 'utf8')) || {};
        return Object.keys(mapping).filter(p => fs.existsSync(p));
      }
    } catch (e) {
      // ignore parse/read errors
    }
    return [];
  }

  // Function to recreate the watcher with current component paths
  function recreateWatcher() {
    if (mdxComponentWatcher) {
      mdxComponentWatcher.close();
    }

    const componentPaths = getComponentPathsFromJson();
    
    // Watch both the component files and the JSON mapping file itself
    const pathsToWatch = [...componentPaths, componentPathJsonPath];
    
    if (pathsToWatch.length === 0) {
      console.log(`INFO  No component paths to watch yet`);
      return;
    }

    try {
      mdxComponentWatcher = chokidar.watch(pathsToWatch, {
        ignored: /node_modules|\.git/,
        persistent: true
      });
      
      console.log(`INFO  Watching ${componentPaths.length} component path(s)`);
      
      // Add event listeners for debugging
      mdxComponentWatcher.on('ready', () => {
        console.log('INFO  Watcher ready, monitoring for changes...');
      });
      
      mdxComponentWatcher.on('error', (error) => {
        console.error('INFO  Watcher error:', error);
      });
      
      mdxComponentWatcher.on('all', (event, watchedPath) => {
        if (event === 'change' || event === 'add' || event === 'unlink') {
          console.log(`INFO  Watcher event: ${event} - ${watchedPath}`);
          
          // If the JSON mapping file was changed, update the watcher
          if (watchedPath === componentPathJsonPath && (event === 'change' || event === 'add')) {
            console.log(`INFO  Component mapping updated, refreshing watched paths...`);
            process.nextTick(() => {
              recreateWatcher();
            });
            return;
          }
        }
      });
    } catch (err) {
      console.warn('Failed to create component watcher:', err.message);
    }
  }

  try {
    const handleComponentChange = (changedPath) => {
      console.log(`\nINFO  ⚡ Component file changed: ${changedPath}`);
      console.log(`INFO  Clearing caches and triggering regeneration...`);

      // PAUSE the watcher to prevent it from detecting the file deletions during regeneration
      try { mdxComponentWatcher.close(); } catch (e) {}

      // Clear the require cache for all components and Babel
      Object.keys(require.cache).forEach(key => {
        if (key.includes('source/components') || key.includes('.hexo-mdx-entry') || key.includes('source\\components')) {
          delete require.cache[key];
        }
      });

      // Delete the compiled entry directory to force recreation
      const fs = require('fs');
      const mdxEntryDir = path.join(hexo.base_dir, '.hexo-mdx-entry');
      if (fs.existsSync(mdxEntryDir)) {
        try {
          fs.rmSync(mdxEntryDir, { recursive: true });
        } catch (err) {
          // Ignore cleanup errors
        }
      }

      // Invalidate Hexo's locals cache
      if (hexo.locals) {
        hexo.locals.invalidate();
      }

      // Read component-path JSON (prefer the copy in public) and try to rerender only affected MDX files
      const mappingCandidates = [
        path.join((hexo && hexo.public_dir) ? hexo.public_dir : path.join(hexo.base_dir || process.cwd(), 'public'), 'hexo-renderer-mdx.component-path.json'),
        path.join(hexo.base_dir || process.cwd(), 'hexo-renderer-mdx.component-path.json')
      ];
      let mapping = null;
      for (const mappingPath of mappingCandidates) {
        try {
          if (fs.existsSync(mappingPath)) {
            mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) || null;
            break;
          }
        } catch (e) {
          mapping = null;
        }
      }

      const normalize = p => path.resolve(p).split(path.sep).join(path.sep);
      const normalizedChanged = normalize(changedPath);

      let affectedMdxFiles = [];
      if (mapping) {
        Object.keys(mapping).forEach(compPath => {
          const normalizedComp = normalize(compPath);
          if (
            normalizedChanged === normalizedComp ||
            normalizedChanged.startsWith(normalizedComp + path.sep) ||
            normalizedComp.startsWith(normalizedChanged + path.sep)
          ) {
            const arr = mapping[compPath] || [];
            arr.forEach(m => { if (m && affectedMdxFiles.indexOf(m) === -1) affectedMdxFiles.push(m); });
          }
        });
      }

      // If we found affected files, try to rerender them individually; otherwise fallback to full clean + generate
      process.nextTick(async () => {
        if (affectedMdxFiles.length > 0) {
          console.log(`INFO  Rerendering ${affectedMdxFiles.length} affected MDX file(s)...`);
          let failed = false;
          for (const mdxFile of affectedMdxFiles) {
            try {
              // Best-effort: try to call a targeted generate if available; fall back to full generate on failure
              await hexo.call('generate', { watch: false, file: mdxFile }).catch(() => { throw new Error('per-file generate unsupported'); });
            } catch (err) {
              failed = true;
              break;
            }
          }
          if (!failed) {
            console.log('INFO  ✓ Per-file regeneration complete');
            // Bundle only the affected entries by their file hash
            const hashes = Array.from(new Set(affectedMdxFiles.map(f => crypto.createHash('md5').update(f).digest('hex').slice(0, 8))));
            hashes.forEach(h => bundleEntryByHash(h));
            // Resume watcher
            recreateWatcher();
            return;
          }
          // Fallback to full clean+generate below
        }

        // Fallback: full clean + generate
        hexo.call('clean').then(() => {
          return hexo.call('generate', {watch: false});
        }).then(() => {
          console.log('INFO  ✓ Regeneration complete');
          // Bundle only the affected entries (if any were identified)
          if (affectedMdxFiles.length > 0) {
            const hashes = Array.from(new Set(affectedMdxFiles.map(f => crypto.createHash('md5').update(f).digest('hex').slice(0, 8))));
            hashes.forEach(h => bundleEntryByHash(h));
          }
          console.log('INFO  ✓ Refresh your browser to see changes');
          // Resume watcher
          recreateWatcher();
        }).catch(err => {
          console.warn('Regeneration error:', err.message);
          // Resume watcher even on error
          recreateWatcher();
        });
      });
    };
    
    mdxComponentWatcher.on('change', handleComponentChange);
    
    console.log('INFO  Component file watcher initialized');
  } catch (err) {
    console.warn('Component file watcher setup warning:', err.message);
  }

  // Initialize the watcher for the first time
  recreateWatcher();
});
}

// Close watcher when Hexo exits to allow process to terminate properly
if (hexo && typeof hexo.on === 'function') {
  hexo.on('exit', function() {
    if (mdxComponentWatcher) {
      mdxComponentWatcher.close();
    }
  });
}

// Ensure component-path JSON is placed into public when site is generated,
// and bundle the entry if one was created during rendering.
try {
  if (
    hexo &&
    hexo.extend &&
    hexo.extend.filter &&
    typeof hexo.extend.filter.register === 'function'
  ) {
    hexo.extend.filter.register('after_generate', function() {
      try {
        const projectRoot = hexo && hexo.base_dir ? hexo.base_dir : process.cwd();
        const src = path.join(projectRoot, 'hexo-renderer-mdx.component-path.json');
        const publicDir = (hexo && hexo.public_dir) ? hexo.public_dir : path.join(projectRoot, 'public');
        const dest = path.join(publicDir, 'hexo-renderer-mdx.component-path.json');
        if (fs.existsSync(src)) {
          fs.mkdirSync(publicDir, { recursive: true });
          fs.copyFileSync(src, dest);
        }
        
        // Bundle the entry file to produce the hydration client bundle
        bundleEntryToPublic();
      } catch (e) {
        // ignore
      }
    });
  }
} catch (e) {
  // ignore if filter registration not available
}

// Export renderer functions for tests and direct usage outside Hexo
try {
  module.exports = {
    mdxRenderer,
    mdxRendererWithTracking
  };
} catch (e) {
  // ignore export errors in unusual runtimes
}