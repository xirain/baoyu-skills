import fs from 'node:fs';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

interface ImageInfo {
  placeholder: string;
  localPath: string;
  originalPath: string;
}

interface ParsedResult {
  title: string;
  author: string;
  summary: string;
  htmlPath: string;
  contentImages: ImageInfo[];
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);

    const request = protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(destPath);
          downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });

    request.on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });

    request.setTimeout(30000, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

function getImageExtension(urlOrPath: string): string {
  const match = urlOrPath.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i);
  return match ? match[1]!.toLowerCase() : 'png';
}

async function resolveImagePath(imagePath: string, baseDir: string, tempDir: string): Promise<string> {
  // Decode URL-encoded characters (e.g., %E8%93%AC -> 蓬)
  const decodedPath = decodeURIComponent(imagePath);

  if (decodedPath.startsWith('http://') || decodedPath.startsWith('https://')) {
    const hash = createHash('md5').update(decodedPath).digest('hex').slice(0, 8);
    const ext = getImageExtension(decodedPath);
    const localPath = path.join(tempDir, `remote_${hash}.${ext}`);

    if (!fs.existsSync(localPath)) {
      console.error(`[md-to-wechat] Downloading: ${decodedPath}`);
      await downloadFile(decodedPath, localPath);
    }
    return localPath;
  }

  if (path.isAbsolute(decodedPath)) {
    return decodedPath;
  }

  return path.resolve(baseDir, decodedPath);
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, string> = {};
  const lines = match[1]!.split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: match[2]! };
}

export async function convertMarkdown(markdownPath: string, options?: { title?: string; theme?: string; localTemp?: boolean }): Promise<ParsedResult> {
  const baseDir = path.dirname(markdownPath);
  const content = fs.readFileSync(markdownPath, 'utf-8');
  const theme = options?.theme ?? 'default';
  const useLocalTemp = options?.localTemp ?? false;

  const { frontmatter, body } = parseFrontmatter(content);

  let title = options?.title ?? frontmatter.title ?? '';
  let bodyWithoutTitle = body;
  if (!title) {
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const headingMatch = trimmed.match(/^#{1,2}\s+(.+)$/);
      if (headingMatch) {
        title = headingMatch[1]!;
        bodyWithoutTitle = body.replace(/^#{1,2}\s+.+\r?\n?/, '');
      }
      break;
    }
  } else {
    bodyWithoutTitle = body.replace(/^#{1,2}\s+.+\r?\n?/, '');
  }
  if (!title) title = path.basename(markdownPath, path.extname(markdownPath));
  const author = frontmatter.author || '';
  let summary = frontmatter.description || frontmatter.summary || '';

  if (!summary) {
    const lines = bodyWithoutTitle.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('![')) continue;
      if (trimmed.startsWith('>')) continue;
      if (trimmed.startsWith('-') || trimmed.startsWith('*')) continue;
      if (/^\d+\./.test(trimmed)) continue;

      const cleanText = trimmed
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1');

      if (cleanText.length > 20) {
        summary = cleanText.length > 120 ? cleanText.slice(0, 117) + '...' : cleanText;
        break;
      }
    }
  }

  const images: Array<{ src: string; placeholder: string }> = [];
  let imageCounter = 0;

  const modifiedBody = bodyWithoutTitle.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
    // Skip HTTP/HTTPS URLs - keep them as-is in the markdown (no local replacement needed)
    if (src.startsWith('http://') || src.startsWith('https://')) {
      return match;
    }
    const placeholder = `WECHATIMGPH_${++imageCounter}`;
    images.push({ src, placeholder });
    return placeholder;
  });

  const modifiedMarkdown = `---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${modifiedBody}`;

  // Use local temp directory (next to md file) or system temp
  const tempDir = useLocalTemp
    ? await (async () => {
        const localTempDir = path.join(baseDir, 'temp');
        await mkdir(localTempDir, { recursive: true });
        return localTempDir;
      })()
    : fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-article-images-'));
  const tempMdPath = path.join(tempDir, 'temp-article.md');
  await writeFile(tempMdPath, modifiedMarkdown, 'utf-8');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const renderScript = path.join(__dirname, 'md', 'render.ts');

  console.error(`[md-to-wechat] Rendering markdown with theme: ${theme}`);

  const result = spawnSync('npx', ['-y', 'bun', renderScript, tempMdPath, '--theme', theme], {
    stdio: ['inherit', 'pipe', 'pipe'],
    cwd: baseDir,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || '';
    throw new Error(`Render failed: ${stderr}`);
  }

  const htmlPath = tempMdPath.replace(/\.md$/i, '.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`HTML file not generated: ${htmlPath}`);
  }

  const contentImages: ImageInfo[] = [];
  for (const img of images) {
    const localPath = await resolveImagePath(img.src, baseDir, tempDir);
    contentImages.push({
      placeholder: img.placeholder,
      localPath,
      originalPath: img.src,
    });
  }

  return {
    title,
    author,
    summary,
    htmlPath,
    contentImages,
  };
}

function printUsage(): never {
  console.log(`Convert Markdown to WeChat-ready HTML with image placeholders

Usage:
  npx -y bun md-to-wechat.ts <markdown_file> [options]

Options:
  --title <title>     Override title
  --theme <name>      Theme name (default, grace, simple)
  --localtemp         Save temp files to 'temp' folder next to the markdown file
  --help              Show this help

Output JSON format:
{
  "title": "Article Title",
  "htmlPath": "/tmp/wechat-article-images/temp-article.html",
  "contentImages": [
    {
      "placeholder": "WECHATIMGPH_1",
      "localPath": "/tmp/wechat-image/img.png",
      "originalPath": "imgs/image.png"
    }
  ]
}

Example:
  npx -y bun md-to-wechat.ts article.md
  npx -y bun md-to-wechat.ts article.md --theme grace
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
  }

  let markdownPath: string | undefined;
  let title: string | undefined;
  let theme: string | undefined;
  let localTemp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--title' && args[i + 1]) {
      title = args[++i];
    } else if (arg === '--theme' && args[i + 1]) {
      theme = args[++i];
    } else if (arg === '--localtemp') {
      localTemp = true;
    } else if (!arg.startsWith('-')) {
      markdownPath = arg;
    }
  }

  if (!markdownPath) {
    console.error('Error: Markdown file path is required');
    process.exit(1);
  }

  // Resolve relative paths based on current working directory
  const resolvedMarkdownPath = path.isAbsolute(markdownPath)
    ? markdownPath
    : path.resolve(process.cwd(), markdownPath);

  if (!fs.existsSync(resolvedMarkdownPath)) {
    console.error(`Error: File not found: ${resolvedMarkdownPath}`);
    process.exit(1);
  }

  const result = await convertMarkdown(resolvedMarkdownPath, { title, theme, localTemp });
  console.log(JSON.stringify(result, null, 2));
}

await main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
