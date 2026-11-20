/**
 * The one configured `sharp` for the whole server.
 *
 * sharp's pixel work happens in libvips, which allocates OUTSIDE the V8 heap.
 * `--max-old-space-size` therefore does nothing to bound it, while Render's
 * memory limit counts every byte of it - which is how a slip render ends as
 * "Web Service rvp-server exceeded its memory limit" rather than a GC pause.
 *
 * Two defaults are wrong for a 512 MB shared instance:
 *
 *   - libvips keeps a 50 MB cache of decoded operations, held indefinitely.
 *     We composite a weighbridge slip a few times an hour, never the same
 *     image twice, so that cache can only ever hold memory we will not reuse.
 *
 *   - the thread pool is sized from `os.cpus()`, which on a container reports
 *     the HOST's cores, not our share. Each worker decodes its own copy of the
 *     frame (a 1920x1080 JPEG is ~6 MB raw), so the default multiplies the
 *     peak of a single composite by a number that has nothing to do with the
 *     CPU we actually get.
 *
 * Import sharp from here, never from 'sharp' directly: the settings are global
 * to the module instance, so the point is that nothing can reach it unset.
 */
import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);

export default sharp;
