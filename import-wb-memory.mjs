/**
 * One-off importer: copies WorkBuddy's existing memory into the dsh-wb-memory
 * store at ~/.dsh/wb-memory/. Run with: node import-wb-memory.mjs
 * (Also exposed at runtime via POST /wb-memory/import.)
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = homedir()
const MEM_DIR = join(home, '.dsh', 'wb-memory')

async function main() {
  await mkdir(join(MEM_DIR, 'projects'), { recursive: true })
  let count = 0

  // 1) user-level memory
  try {
    await cp(join(home, '.workbuddy', 'MEMORY.md'), join(MEM_DIR, 'USER.md'), { force: true })
    count++
    console.log('imported USER.md (user-level MEMORY.md)')
  } catch (e) {
    console.warn('skip user MEMORY.md:', e.message)
  }

  // 2) per-project memory under D:/datas/Workbuddy/<proj>/.workbuddy/memory
  const wbRoot = 'D:/datas/Workbuddy'
  try {
    const projects = await readdir(wbRoot)
    for (const p of projects) {
      const mem = join(wbRoot, p, '.workbuddy', 'memory')
      try {
        const s = await stat(mem)
        if (!s.isDirectory()) continue
      } catch {
        continue
      }
      const dest = join(MEM_DIR, 'projects', p)
      await mkdir(dest, { recursive: true })
      await cp(mem, dest, { recursive: true, force: true })
      count++
      console.log('imported project:', p)
    }
  } catch (e) {
    console.warn('project scan failed:', e.message)
  }

  // 3) misc user memory uuid files
  try {
    const mdir = join(home, '.workbuddy', 'memory')
    const files = await readdir(mdir)
    const dest = join(MEM_DIR, 'projects', '_imported')
    await mkdir(dest, { recursive: true })
    for (const f of files) {
      if (f.endsWith('.md')) {
        await cp(join(mdir, f), join(dest, f), { force: true })
        count++
      }
    }
    if (files.length) console.log('imported misc user memory files:', files.length)
  } catch (e) {
    console.warn('misc import skipped:', e.message)
  }

  // 4) write default config: enabled on after a fresh import
  await mkdir(MEM_DIR, { recursive: true })
  const cfgPath = join(MEM_DIR, 'config.json')
  let cfg = { enabled: true }
  try {
    const prev = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(cfgPath, 'utf8')))
    if (typeof prev.enabled === 'boolean') cfg = prev
  } catch {}
  const { writeFile } = await import('node:fs/promises')
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')

  console.log('\nDone. Imported', count, 'memory locations into', MEM_DIR)
  console.log('Config:', JSON.stringify(cfg))
}

main().catch((e) => {
  console.error('import failed:', e)
  process.exit(1)
})
