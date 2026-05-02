// Markdown → PDF via marked + Chromium headless print.
// Usage: node md2pdf.js <input.md> <output.pdf> [title]
const { chromium } = require('playwright');
const { marked } = require('marked');
const fs = require('fs');
const path = require('path');

async function main() {
  const [, , inputPath, outputPath, title = 'Tiara CRM'] = process.argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node md2pdf.js <input.md> <output.pdf> [title]');
    process.exit(1);
  }

  const md = fs.readFileSync(inputPath, 'utf8');
  const docDir = path.dirname(path.resolve(inputPath));
  // Resolve relative image paths (assets/screenshots/...) to absolute file:// URLs
  const html = marked.parse(md).replace(
    /<img\s+src="([^"]+)"/g,
    (m, src) => {
      if (src.startsWith('http') || src.startsWith('file://')) return m;
      const abs = path.resolve(docDir, src);
      return `<img src="file://${abs}"`;
    }
  );

  const fullHtml = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    @page { size: A4; margin: 18mm 14mm; }
    body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; line-height: 1.55; color: #1e293b; max-width: 740px; margin: 0 auto; font-size: 11pt; }
    h1 { color: #0f172a; font-size: 24pt; border-bottom: 3px solid #10b981; padding-bottom: 8px; margin-top: 0; }
    h2 { color: #0f172a; font-size: 16pt; margin-top: 24px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; page-break-after: avoid; }
    h3 { color: #334155; font-size: 13pt; margin-top: 18px; page-break-after: avoid; }
    h4 { color: #475569; font-size: 11pt; margin-top: 14px; page-break-after: avoid; }
    p { margin: 8px 0; }
    code { background: #f1f5f9; padding: 1px 5px; border-radius: 3px; font-size: 9pt; color: #be123c; }
    pre { background: #f1f5f9; padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 9pt; line-height: 1.4; }
    pre code { background: none; padding: 0; color: #1e293b; }
    blockquote { border-left: 4px solid #10b981; padding: 6px 14px; margin: 12px 0; background: #f0fdf4; color: #14532d; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 10pt; page-break-inside: avoid; }
    th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; vertical-align: top; }
    th { background: #f1f5f9; font-weight: 600; }
    img { max-width: 100%; border: 1px solid #e2e8f0; border-radius: 4px; margin: 8px 0; page-break-inside: avoid; display: block; }
    a { color: #10b981; text-decoration: none; }
    ul, ol { padding-left: 22px; }
    li { margin: 3px 0; }
    hr { border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0; }
    .footer { color: #64748b; font-size: 9pt; text-align: center; margin-top: 20px; }
  </style>
</head>
<body>
${html}
<div class="footer">Generated ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })} · Tiara CRM</div>
</body>
</html>`;

  // Write temp HTML next to source for image resolution
  const tmpHtml = path.resolve(docDir, '.tmp-' + Date.now() + '.html');
  fs.writeFileSync(tmpHtml, fullHtml);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('file://' + tmpHtml, { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', right: '14mm', bottom: '18mm', left: '14mm' },
  });
  await browser.close();
  fs.unlinkSync(tmpHtml);
  console.log(`[done] ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(0)} KB)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
