const assert = require('assert');
const {puppeteer, launchOptions, measureStringVisibility} = require('./render_mockup');
(async () => {
    const browser = await puppeteer.launch(launchOptions());
    try {
        const page = await browser.newPage();
        await page.setViewport({width:800,height:600});
        await page.setContent(`<style>button,input{width:140px;height:35px}</style>
            <button>Text button</button><input type="submit" value="Create API key">
            <input type="button" value="Input button"><input type="reset" value="Reset fields">
            <button aria-label="Admin menu"><svg width="20" height="20"><rect width="20" height="20"/></svg></button>
            <span id="control-label" hidden>Named control</span><button aria-labelledby="control-label">⚙</button>
            <a data-rtfm-action-target="open-menu" aria-label="Scripted menu"><svg width="20" height="20"><rect width="20" height="20"/></svg></a>
            <input type="hidden" value="Hidden value"><input type="password" value="Secret value">
            <div aria-label="Not a control" style="width:80px;height:30px"></div>
            <button style="display:none" aria-label="Hidden control"></button>
            <div style="opacity:0"><input type="submit" value="Transparent submit"></div>
            <div style="overflow:hidden;height:0"><button aria-label="Clipped control"></button></div>
            <input type="submit" value="Below crop" style="position:absolute;top:1000px">
            <input type="submit" value="Right of crop" style="position:absolute;left:1000px">
            <button style="visibility:hidden">Invisible text</button>`);
        const visible = ['Text button','Create API key','Input button','Reset fields','Admin menu','Named control','Scripted menu'];
        const hidden = ['Hidden value','Secret value','Not a control','Hidden control','Transparent submit','Clipped control','Below crop','Right of crop','Invisible text','Absent'];
        const results = await measureStringVisibility(page,[...visible,...hidden],600,800);
        for (const item of results) assert.equal(item.visible,visible.includes(item.string),JSON.stringify(item));
        assert.equal(results.find(r => r.string === 'Create API key').match_kind, 'input_value');
        assert.equal(results.find(r => r.string === 'Admin menu').match_kind, 'accessible_control');
        console.log('Text, input values and named-control visibility tests passed');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
