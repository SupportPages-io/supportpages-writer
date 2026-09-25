const ARTICLE_TYPES = ['how-to', 'troubleshooting', 'concept', 'faq'];
const PRESENTATIONS = {
    prose: ['lead', 'body', 'summary'],
    section: ['numbered', 'plain'],
    list: ['bullets', 'checklist', 'tips'],
};

function blocks(article) {
    if (article && article.schema_version === 2 && Array.isArray(article.blocks)) return article.blocks;

    const result = [];
    if (article && article.introduction) result.push({ id: 'introduction', type: 'prose', presentation: 'lead', content: article.introduction });
    if (Array.isArray(article && article.prerequisites) && article.prerequisites.length) {
        result.push({ id: 'prerequisites', type: 'list', presentation: 'checklist', title: 'Prerequisites', items: article.prerequisites });
    }
    for (const [index, step] of ((article && article.steps) || []).entries()) {
        result.push({ id: `step-${index + 1}`, type: 'section', presentation: 'numbered', ...step });
    }
    if (Array.isArray(article && article.tips) && article.tips.length) {
        result.push({ id: 'tips', type: 'list', presentation: 'tips', title: 'Tips', items: article.tips });
    }
    if (article && article.summary) result.push({ id: 'summary', type: 'prose', presentation: 'summary', title: 'Summary', content: article.summary });
    return result;
}

function sections(article) {
    return blocks(article).filter(block => block.type === 'section');
}

function articleType(article) {
    return ARTICLE_TYPES.includes(article && article.article_type) ? article.article_type : 'how-to';
}

module.exports = { ARTICLE_TYPES, PRESENTATIONS, blocks, sections, articleType };
