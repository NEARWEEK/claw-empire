#!/usr/bin/env node

/**
 * Saiba AI Quick Wins Audit Tool
 * Usage: node audit.mjs <url>
 * Generates a branded audit report for prospective fashion/lifestyle clients.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, 'reports');

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.text();
}

function detectTechStack(html, headers) {
  const stack = [];
  if (html.includes('Shopify') || html.includes('cdn.shopify.com')) stack.push('Shopify');
  if (html.includes('WooCommerce') || html.includes('woocommerce')) stack.push('WooCommerce');
  if (html.includes('Centra')) stack.push('Centra');
  if (html.includes('Magento')) stack.push('Magento');
  if (html.includes('BigCommerce')) stack.push('BigCommerce');
  if (html.includes('Squarespace')) stack.push('Squarespace');
  if (html.includes('Wix')) stack.push('Wix');
  if (html.includes('WordPress') || html.includes('wp-content')) stack.push('WordPress');
  if (html.includes('next/') || html.includes('_next/')) stack.push('Next.js');
  if (html.includes('Vercel')) stack.push('Vercel');
  if (html.includes('Cloudflare')) stack.push('Cloudflare');
  if (html.includes('Google Tag Manager') || html.includes('gtm.js')) stack.push('Google Tag Manager');
  if (html.includes('google-analytics') || html.includes('gtag')) stack.push('Google Analytics');
  if (html.includes('klaviyo')) stack.push('Klaviyo');
  if (html.includes('hotjar')) stack.push('Hotjar');
  if (html.includes('facebook.net/en_US/fbevents')) stack.push('Meta Pixel');
  if (html.includes('tiktok')) stack.push('TikTok Pixel');
  return stack.length ? stack : ['Custom / Unknown'];
}

function extractMeta(html) {
  const get = (pattern) => {
    const match = html.match(pattern);
    return match ? match[1].trim() : null;
  };
  return {
    title: get(/<title[^>]*>([^<]+)<\/title>/i),
    description: get(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i),
    ogTitle: get(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i),
    ogDescription: get(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i),
    ogImage: get(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i),
    canonical: get(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i),
  };
}

function extractSocials(html) {
  const socials = {};
  const patterns = {
    instagram: /href=["'](https?:\/\/(www\.)?instagram\.com\/[^"'\s]+)["']/gi,
    facebook: /href=["'](https?:\/\/(www\.)?facebook\.com\/[^"'\s]+)["']/gi,
    tiktok: /href=["'](https?:\/\/(www\.)?tiktok\.com\/@[^"'\s]+)["']/gi,
    linkedin: /href=["'](https?:\/\/(www\.)?linkedin\.com\/[^"'\s]+)["']/gi,
    twitter: /href=["'](https?:\/\/(www\.)?(twitter|x)\.com\/[^"'\s]+)["']/gi,
    youtube: /href=["'](https?:\/\/(www\.)?youtube\.com\/[^"'\s]+)["']/gi,
  };
  for (const [platform, pattern] of Object.entries(patterns)) {
    const match = html.match(pattern);
    if (match) socials[platform] = match[0].match(/href=["']([^"']+)["']/)[1];
  }
  return socials;
}

function countAssets(html) {
  const images = (html.match(/<img[^>]+>/gi) || []).length;
  const scripts = (html.match(/<script[^>]+src/gi) || []).length;
  const stylesheets = (html.match(/<link[^>]+stylesheet/gi) || []).length;
  return { images, scripts, stylesheets };
}

function generateOpportunities(techStack, meta, socials, assets) {
  const opportunities = [];

  // Always relevant for fashion brands
  opportunities.push({
    title: 'Product Description Automation',
    description: 'Auto-generate SEO-optimized product descriptions from product photos and basic metadata. Train on your brand voice for consistent tone across all SKUs.',
    hoursSaved: 15,
    complexity: 1,
    play: 'Play 1: Product Content Engine',
  });

  opportunities.push({
    title: 'Social Media Content Pipeline',
    description: 'Generate Instagram captions, TikTok scripts, and Facebook posts from product launches and campaign briefs. Schedule and publish automatically.',
    hoursSaved: 10,
    complexity: 1,
    play: 'Play 1: Product Content Engine',
  });

  if (techStack.includes('Shopify') || techStack.includes('WooCommerce')) {
    opportunities.push({
      title: 'Order-to-Invoice Automation',
      description: `Connect ${techStack.includes('Shopify') ? 'Shopify' : 'WooCommerce'} orders directly to your accounting system. Eliminate manual invoice creation and reduce errors.`,
      hoursSaved: 8,
      complexity: 2,
      play: 'Play 5: Process Automation',
    });
  } else {
    opportunities.push({
      title: 'E-commerce Integration Hub',
      description: 'Connect your e-commerce platform with accounting, shipping, and CRM tools to eliminate manual data entry across systems.',
      hoursSaved: 12,
      complexity: 2,
      play: 'Play 5: Process Automation',
    });
  }

  opportunities.push({
    title: 'Customer Service Auto-Response',
    description: 'AI-powered responses for the top 20 customer inquiry types (order status, returns, sizing, shipping). 24/7 coverage with human escalation for edge cases.',
    hoursSaved: 20,
    complexity: 2,
    play: 'Play 2: Customer Service Autopilot',
  });

  opportunities.push({
    title: 'Real-Time Business Dashboard',
    description: 'Replace spreadsheet reporting with a live dashboard showing revenue, orders, inventory levels, and marketing performance. Automated weekly PDF summaries.',
    hoursSaved: 5,
    complexity: 1,
    play: 'Play 6: Business Dashboard',
  });

  // Sort by hours saved descending
  opportunities.sort((a, b) => b.hoursSaved - a.hoursSaved);
  return opportunities.slice(0, 5);
}

function recommendTier(opportunities) {
  const totalHours = opportunities.reduce((sum, o) => sum + o.hoursSaved, 0);
  if (totalHours > 40) return { tier: 'Tier 2: Saiba Growth', reason: 'Multiple high-impact automations identified — monthly sprint delivery recommended.' };
  if (totalHours > 20) return { tier: 'Tier 1: Saiba Essentials', reason: 'Strong quick-win potential — start with essentials and scale based on results.' };
  return { tier: 'Tier 1: Saiba Essentials', reason: 'Good foundation for AI-powered improvements.' };
}

function generateReport(url, domain, techStack, meta, socials, assets, opportunities, recommendation) {
  const date = new Date().toISOString().split('T')[0];
  const socialList = Object.entries(socials).map(([p, u]) => `- ${p}: ${u}`).join('\n') || '- No social links detected on homepage';
  const complexityLabel = (c) => ['', 'Low', 'Medium', 'High'][c];

  return `# Saiba AI Quick Wins Report

**Client:** ${meta.title || domain}
**URL:** ${url}
**Generated:** ${date}
**Prepared by:** Peter Humaidan — Saiba

---

## Executive Summary

We analyzed ${url} to identify immediate automation opportunities. Based on the current tech stack and typical operations for fashion/lifestyle brands, we identified **${opportunities.reduce((s, o) => s + o.hoursSaved, 0)}+ hours/week** of potential time savings across ${opportunities.length} key areas.

---

## Tech Stack Detected

${techStack.map(t => `- ${t}`).join('\n')}

## SEO & Meta

| Field | Status |
|-------|--------|
| Title | ${meta.title ? `${meta.title.substring(0, 60)}` : 'Missing'} |
| Description | ${meta.description ? `${meta.description.substring(0, 80)}...` : 'Missing'} |
| OG Tags | ${meta.ogTitle ? 'Present' : 'Missing'} |
| Canonical | ${meta.canonical ? 'Set' : 'Missing'} |

## Social Presence

${socialList}

## Page Assets

- Images: ${assets.images}
- Scripts: ${assets.scripts}
- Stylesheets: ${assets.stylesheets}

---

## Top 5 Automation Opportunities

${opportunities.map((o, i) => `
### ${i + 1}. ${o.title}

${o.description}

| Metric | Value |
|--------|-------|
| Estimated hours saved/week | **${o.hoursSaved}h** |
| Implementation complexity | ${complexityLabel(o.complexity)} |
| Recommended play | ${o.play} |
`).join('\n')}

---

## Recommended Package

**${recommendation.tier}**

${recommendation.reason}

Total estimated time savings: **${opportunities.reduce((s, o) => s + o.hoursSaved, 0)}+ hours/week**

---

## Next Steps

1. **Book a free 30-minute consultation** to walk through these findings
2. We'll prioritize the top 2-3 opportunities based on your team's input
3. First automation can be live within 2 weeks of kickoff

**Contact:**
- Email: hello@saiba.dk
- Phone: +45 31 41 28 29
- Slack: We'll set up a dedicated channel for you

---

*This report was generated by Saiba's automated audit system. For a deeper analysis including competitor benchmarking and custom recommendations, book a consultation at saiba.dk.*
`;
}

// Main
async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node audit.mjs <url>');
    console.error('Example: node audit.mjs https://palmes.co');
    process.exit(1);
  }

  const fullUrl = url.startsWith('http') ? url : `https://${url}`;
  const domain = new URL(fullUrl).hostname.replace('www.', '');

  console.log(`Auditing ${fullUrl}...`);

  try {
    const html = await fetchPage(fullUrl);
    const techStack = detectTechStack(html);
    const meta = extractMeta(html);
    const socials = extractSocials(html);
    const assets = countAssets(html);
    const opportunities = generateOpportunities(techStack, meta, socials, assets);
    const recommendation = recommendTier(opportunities);

    const report = generateReport(fullUrl, domain, techStack, meta, socials, assets, opportunities, recommendation);

    mkdirSync(REPORTS_DIR, { recursive: true });
    const reportPath = join(REPORTS_DIR, `${domain}-audit.md`);
    writeFileSync(reportPath, report);

    console.log(`Report saved to: ${reportPath}`);
    console.log(`\nQuick summary:`);
    console.log(`  Tech stack: ${techStack.join(', ')}`);
    console.log(`  Opportunities: ${opportunities.length}`);
    console.log(`  Est. hours saved: ${opportunities.reduce((s, o) => s + o.hoursSaved, 0)}h/week`);
    console.log(`  Recommended: ${recommendation.tier}`);
  } catch (err) {
    console.error(`Audit failed: ${err.message}`);
    process.exit(1);
  }
}

main();
