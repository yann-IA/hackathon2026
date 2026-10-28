// Extraction du texte des documents déposés dans server/documents (tracts, guides de vote…).
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const SUPPORTED = ['.pdf', '.txt', '.md', '.html', '.htm', '.png', '.jpg', '.jpeg', '.webp']

/** Un outil en ligne de commande est-il installé ? (tesseract, pdftoppm) */
async function has(cmd) {
  try {
    await run(cmd, ['--version'])
    return true
  } catch (e) {
    return e.code !== 'ENOENT'
  }
}

/** Reconnaissance de caractères (images, PDF scannés) avec Tesseract, en français. */
async function ocr(image) {
  const { stdout } = await run('tesseract', [image, 'stdout', '-l', 'fra'], { maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

export function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
}

/**
 * Texte d'un document, page par page : [{ page, text }]. Les PDF sans texte (scannés) et les
 * images passent par la reconnaissance de caractères si Tesseract est installé.
 */
export async function extractPages(file, log = console) {
  const ext = extname(file).toLowerCase()
  if (ext === '.txt' || ext === '.md') return [{ page: 1, text: await readFile(file, 'utf8') }]
  if (ext === '.html' || ext === '.htm') return [{ page: 1, text: htmlToText(await readFile(file, 'utf8')) }]
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    if (!(await has('tesseract'))) {
      log.warn(`  ${file} : image ignorée (installe Tesseract pour lire les images : brew install tesseract tesseract-lang)`)
      return []
    }
    return [{ page: 1, text: await ocr(file) }]
  }
  if (ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)))
    const { text } = await extractText(pdf, { mergePages: false })
    const pages = text.map((t, i) => ({ page: i + 1, text: t }))
    const empty = pages.filter((p) => p.text.replace(/\s/g, '').length < 40)
    if (empty.length && (await has('tesseract')) && (await has('pdftoppm'))) {
      // pages scannées (sans texte) : rendues en image puis lues par Tesseract
      const dir = await mkdtemp(join(tmpdir(), 'assistante-ocr-'))
      try {
        for (const p of empty) {
          await run('pdftoppm', ['-r', '200', '-f', String(p.page), '-l', String(p.page), '-png', file, join(dir, 'p')])
          const img = (await readdir(dir)).find((f) => f.endsWith('.png'))
          if (img) {
            p.text = await ocr(join(dir, img))
            await rm(join(dir, img))
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    } else if (empty.length === pages.length) {
      log.warn(`  ${file} : PDF sans texte (scanné). Installe Tesseract et Poppler pour le lire : brew install tesseract tesseract-lang poppler`)
    }
    return pages
  }
  return []
}
