#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * Bölgesel Arama Görünürlüğü ve Talep Kanalları Rehberi
 * Dokümantasyon Şema ve Çeşitlilik Doğrulama Aracı
 * (Bu dosya depoya 1 kere eklenir; tüm docs/*.md dosyalarını otomatik doğrular.)
 *
 * Kullanım: node scripts/validate-docs.mjs
 */

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, 'docs');
const MASTER_MATRIX_PATH = path.join(ROOT, 'data', 'talep-matrisi.json');
const RECORDS_DIR = path.join(ROOT, 'data', 'kayitlar');

const MIN_WORDS = 200;
const MAX_SIMILARITY = 0.65;

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLocaleLowerCase('tr-TR')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function jaccardSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function loadCombinedMatrix(errors) {
  const byPath = new Map();

  // 1) Toplu ana dosya: data/talep-matrisi.json
  if (fs.existsSync(MASTER_MATRIX_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(MASTER_MATRIX_PATH, 'utf8'));
      if (!Array.isArray(parsed)) {
        errors.push('data/talep-matrisi.json kök yapısı dizi (array) olmalıdır.');
      } else {
        for (const row of parsed) {
          if (row?.dosyaYolu) byPath.set(row.dosyaYolu, row);
        }
      }
    } catch (err) {
      errors.push(`data/talep-matrisi.json okunamadı: ${err.message}`);
    }
  }

  // 2) Çakışmasız tekil kayıt dosyaları: data/kayitlar/*.json
  if (fs.existsSync(RECORDS_DIR)) {
    const jsonFiles = fs.readdirSync(RECORDS_DIR).filter((f) => f.endsWith('.json'));
    for (const jf of jsonFiles) {
      try {
        const row = JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, jf), 'utf8'));
        if (row?.dosyaYolu) byPath.set(row.dosyaYolu, row);
      } catch (err) {
        errors.push(`data/kayitlar/${jf} okunamadı: ${err.message}`);
      }
    }
  }

  return Array.from(byPath.values());
}

function main() {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(DOCS_DIR)) {
    console.error('HATA: docs/ klasörü bulunamadı.');
    process.exit(1);
  }

  const matrix = loadCombinedMatrix(errors);
  if (matrix.length === 0) {
    errors.push('data/talep-matrisi.json veya data/kayitlar/*.json içinde hiç kayıt bulunamadı.');
  }

  const indexedPaths = new Set(matrix.map((row) => row.dosyaYolu));
  for (const row of matrix) {
    if (!row.id || !row.il || !row.odakKonu || !row.dosyaYolu) {
      errors.push(`Matris kaydı eksik alan içeriyor: ${JSON.stringify(row)}`);
    }
    if (row.kurulumSuresi && row.kurulumSuresi !== '1 hafta') {
      errors.push(`Matris süre tutarsızlığı (${row.dosyaYolu}): "${row.kurulumSuresi}" yerine "1 hafta" olmalı.`);
    }
  }

  const mdFiles = fs
    .readdirSync(DOCS_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort();

  if (mdFiles.length === 0) {
    console.error('HATA: docs/ klasöründe doğrulanacak .md dosyası yok.');
    process.exit(1);
  }

  const summaries = [];

  for (const fileName of mdFiles) {
    const relPath = `docs/${fileName}`;
    const content = fs.readFileSync(path.join(DOCS_DIR, fileName), 'utf8');
    const words = content.trim().split(/\s+/).filter(Boolean);

    if (!/^#\s+.+/m.test(content)) {
      errors.push(`${relPath}: H1 (# Başlık) eksik.`);
    }
    if (!/^##\s+.+/m.test(content)) {
      errors.push(`${relPath}: En az bir H2 (## Alt Başlık) eksik.`);
    }
    if (!/^\|.+\|\s*\n\|\s*[-:]+/m.test(content)) {
      errors.push(`${relPath}: Yapılandırılmış Markdown karşılaştırma tablosu eksik.`);
    }
    if (words.length < MIN_WORDS) {
      errors.push(`${relPath}: İçerik derinliği yetersiz (${words.length} kelime, minimum ${MIN_WORDS}).`);
    }

    const faqCount = (content.match(/^Soru:/gim) || []).length;
    if (faqCount < 3) {
      warnings.push(`${relPath}: En az 3 Soru-Cevap önerilir (bulunan: ${faqCount}).`);
    }

    if (!indexedPaths.has(relPath)) {
      errors.push(`${relPath}: data/talep-matrisi.json veya data/kayitlar/ içinde kayıtlı değil.`);
    }

    const h1Line = (content.match(/^#\s+(.+)/m) || [])[1] || '';
    const firstParagraph =
      content
        .split(/\n\n+/)
        .find((block) => block.trim() && !block.trim().startsWith('#') && !block.trim().startsWith('|')) || '';

    summaries.push({
      relPath,
      h1Tokens: tokenize(h1Line),
      openerTokens: tokenize(firstParagraph)
    });
  }

  for (let i = 0; i < summaries.length; i += 1) {
    for (let j = i + 1; j < summaries.length; j += 1) {
      const openerSim = jaccardSimilarity(summaries[i].openerTokens, summaries[j].openerTokens);
      if (openerSim >= MAX_SIMILARITY) {
        warnings.push(
          `Yüksek giriş benzerliği (${Math.round(openerSim * 100)}%): ${summaries[i].relPath} <-> ${summaries[j].relPath}`
        );
      }
    }
  }

  console.log(`Toplam ${mdFiles.length} doküman ve ${matrix.length} matris kaydı incelendi.`);
  warnings.forEach((w) => console.warn('UYARI:', w));

  if (errors.length > 0) {
    errors.forEach((e) => console.error('HATA:', e));
    process.exit(1);
  }

  console.log('DOĞRULAMA BAŞARILI: Tüm dokümanlar şema ve çeşitlilik kurallarına uygun.');
}

main();
