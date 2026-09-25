#!/usr/bin/env node
/**
 * HTML Validation Script
 * Validates HTML mockups before rendering to catch common issues.
 * Returns JSON with validation results.
 */

const fs = require('fs');

function validateHtml(htmlFile) {
    const html = fs.readFileSync(htmlFile, 'utf8').trim();
    const errors = [];
    const warnings = [];

    if (!html) {
        errors.push('HTML file is empty');
        return { valid: false, errors, warnings, html_length: 0 };
    }

    if (!html.match(/<!DOCTYPE\s+html>/i)) {
        warnings.push('Missing DOCTYPE declaration');
    }

    if (!/<html/i.test(html)) {
        errors.push('Missing <html> tag');
    }

    if (!/<body/i.test(html)) {
        errors.push('Missing <body> tag');
    }

    const styleOpenCount = (html.match(/<style/gi) || []).length;
    const styleCloseCount = (html.match(/<\/style>/gi) || []).length;
    if (styleOpenCount !== styleCloseCount) {
        errors.push(`Mismatched style tags: ${styleOpenCount} opening, ${styleCloseCount} closing`);
    }

    const scriptOpenCount = (html.match(/<script/gi) || []).length;
    const scriptCloseCount = (html.match(/<\/script>/gi) || []).length;
    if (scriptOpenCount !== scriptCloseCount) {
        errors.push(`Mismatched script tags: ${scriptOpenCount} opening, ${scriptCloseCount} closing`);
    }

    const fileUrlMatches = html.match(/(?:src|href)=["']file:\/\/[^"']+["']/gi);
    if (fileUrlMatches) {
        fileUrlMatches.forEach((match) => {
            errors.push(`file:// URL found (won't render): ${match.substring(0, 50)}...`);
        });
    }

    const imgWithoutSrc = html.match(/<img(?![^>]*\bsrc\s*=)[^>]*>/gi);
    if (imgWithoutSrc) {
        warnings.push(`${imgWithoutSrc.length} image(s) without src attribute`);
    }

    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
        const bodyContent = bodyMatch[1].replace(/<[^>]*>/g, '').trim();
        if (bodyContent.length === 0) {
            const hasVisibleElements = /<(div|p|h[1-6]|span|button|input|form|table|ul|ol|li|img|a)[^>]*>/i.test(bodyMatch[1]);
            if (!hasVisibleElements) {
                warnings.push('Body appears to have no visible content');
            }
        }
    }

    if (html.includes('class="undefined"')) {
        warnings.push('Found "undefined" in class attribute - possible template error');
    }
    if (html.includes('class="null"')) {
        warnings.push('Found "null" in class attribute - possible template error');
    }

    const hasHead = /<head/i.test(html);
    if (!hasHead) {
        warnings.push('Missing <head> tag - styles may not load correctly');
    }

    const hasStyle = /<style/i.test(html);
    const hasStylesheet = /<link[^>]*stylesheet/i.test(html);
    const hasInlineStyle = /style\s*=/i.test(html);
    if (!hasStyle && !hasStylesheet && !hasInlineStyle) {
        warnings.push('No CSS found - mockup may appear unstyled');
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        html_length: html.length,
        has_styles: hasStyle || hasStylesheet || hasInlineStyle,
        has_doctype: /<!DOCTYPE\s+html>/i.test(html),
    };
}

const htmlFile = process.argv[2];
if (!htmlFile) {
    console.error('Usage: validate_html.js <html_file>');
    process.exit(1);
}

if (!fs.existsSync(htmlFile)) {
    console.error(JSON.stringify({ valid: false, errors: [`File not found: ${htmlFile}`], warnings: [] }));
    process.exit(1);
}

try {
    const result = validateHtml(htmlFile);
    console.log(JSON.stringify(result));
    process.exit(result.valid ? 0 : 1);
} catch (e) {
    console.error(JSON.stringify({ valid: false, errors: [`Validation error: ${e.message}`], warnings: [] }));
    process.exit(1);
}
