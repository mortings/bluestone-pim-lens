// The extension, unchanged, in a real Chromium: npm run test:browser
//
// It is loaded as Chrome loads it, switched on for a test shop page, and used with
// real mouse clicks and key presses. The PIM's hostnames point at a local stand-in
// PIM, so nothing reaches a real PIM. See lib.js for the set-up.
//
// Two things a test cannot do, and how they are stood in for:
//   - clicking the toolbar button (which is what gives the extension access to the
//     page): the test copy of the manifest names the test shop's address instead;
//   - answering Chrome's permission question for a shop's image host: one scenario
//     checks that the question is reached, another starts with the answer "Allow".
const L = require('./lib.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARMED = 900; // a button that writes to the PIM acts only after it has been showing for a moment
const results = [];
function ok(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

const pill = (label) => (n, tx, a) => n.nodeName === 'BUTTON' && /pill/.test(a.class || '') && !('hidden' in a) && (!label || tx === label);
const closeCard = (n, tx, a) => n.nodeName === 'BUTTON' && a['aria-label'] === 'Close';

/** One browser, one stand-in PIM, one shop page with the Lens's inside view. */
async function scenario(title, options, body) {
  console.log(`\n${title}`);
  const state = { requests: [], mocks: {}, hang: false };
  const mock = L.createMock();
  const signedOut = L.createMock({ signedOut: true });
  state.mocks['demo-ui.test.bluestonepim.com'] = options.signedOut ? signedOut : mock;
  state.mocks['app.test.bluestonepim.com'] = signedOut;
  const pim = await L.startPim(state);
  const shop = await L.startShop(state);
  const launched = await L.launch(L.copyExtension(options.allowHosts), !process.env.HEADED);
  const context = launched.context;
  const world = { sw: launched.sw, context, state, mock, signedOut };
  context.on('serviceworker', (w) => (world.sw = w));
  try {
    const page = await context.newPage();
    world.page = page;
    world.pageErrors = [];
    page.on('pageerror', (e) => world.pageErrors.push(String(e)));
    await page.goto(`http://shop.example/${options.page || 'book.html'}`);
    world.cdp = await context.newCDPSession(page);
    world.lens = L.lensView(page, world.cdp);
    world.toggle = () => world.sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://shop.example/*' });
      await showLens(tab, 'lens:toggle');
    });
    await body(world);
    ok('no errors on the page', world.pageErrors.length === 0, world.pageErrors.join('; '));
  } catch (e) {
    ok(`${title}: ran to the end`, false, e.message);
  } finally {
    await context.close().catch(() => {});
    if (pim.closeAllConnections) pim.closeAllConnections();
    pim.close();
    shop.close();
  }
}

async function everydayUse({ lens, page, cdp, sw, mock, toggle }) {
  await toggle();
  await lens.waitFor(/10 from the PIM/, 15000);
  ok('the Lens starts and compares the page with the PIM', true);

  // Pictures: the shop's image host needs the user's permission first.
  let t = await lens.waitFor(/not compared yet|Pictures:/, 10000);
  ok('pictures wait for permission, and the image host is named', /read pictures from img\.shop\.example/.test(t));
  await lens.click(lens.button('Allow it'));
  await sleep(2500);
  t = await lens.text();
  ok('"Allow it" reaches Chrome\'s permission question', !/Chrome only takes this from its own menu|Not allowed/.test(t));

  // A pill's card, in Suggest mode.
  await lens.click(pill('Differs'));
  t = await lens.waitFor(/Suggested value/, 5000);
  ok('a pill opens its card', /On this page \| 247 g \| In the PIM \| 240 gr/.test(t));
  // A click made by a script (what a hostile page would do if it could reach the button) does nothing.
  const sendButton = (await lens.all(lens.button('Send suggestion')))[0];
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: sendButton.backendNodeId });
  await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){ this.click(); }' });
  await sleep(600);
  ok('a click made by a script is ignored', mock.db.tasks.length === 0 && !/Choose who should get the task/.test(await lens.text()));
  await sleep(ARMED);
  await lens.click(lens.button('Send suggestion'));
  await lens.waitFor(/Choose who should get the task/, 4000);
  ok('a real click is acted on, and asks who gets the task', true);
  const who = (await lens.all((n, tx, a) => n.nodeName === 'SELECT' && a['aria-label'] === 'Who gets suggestions'))[0];
  await cdp.send('DOM.focus', { backendNodeId: who.backendNodeId });
  await page.keyboard.type('Anna');
  await sleep(500);
  if (!/Goes to Anna Berg/.test(await lens.text())) await page.keyboard.press('Enter');
  await lens.waitFor(/Goes to Anna Berg/, 3000);
  // What a page script can find out about the open card: nothing.
  const probe = await page.evaluate(() => {
    const found = ['240 gr', 'In the PIM', 'Unit Weight', 'Anna Berg', 'Nordic Thread Demo', 'Differs'].filter((t) => window.find(t, false, false, true));
    getSelection().selectAllChildren(document.documentElement);
    const selected = String(getSelection());
    getSelection().removeAllRanges();
    getSelection().removeAllRanges();
    return { found, leaked: /240 gr|Unit Weight|Nordic Thread/.test(selected), control: window.find('Forlag', false, false, true) };
  });
  ok('the page cannot search for or select the Lens\'s text', probe.control && probe.found.length === 0 && !probe.leaked, JSON.stringify(probe));
  // Something drawn over the card (see-through to clicks, as a hostile page would do it): the button does not act.
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.id = 'cover';
    cover.setAttribute('popover', 'manual');
    cover.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;margin:0;border:0;background:#fff;pointer-events:none;';
    document.body.append(cover);
    cover.showPopover();
  });
  await sleep(ARMED);
  await lens.click(lens.button('Send suggestion'));
  await sleep(700);
  ok('a button that is covered by the page does nothing', mock.db.tasks.length === 0 && /Nothing was sent/.test(await lens.text()));
  await page.evaluate(() => document.getElementById('cover').remove());
  await sleep(ARMED);
  await lens.click(lens.button('Send suggestion'));
  await lens.waitFor(/Sent to .* as a task/, 8000);
  const task = mock.db.tasks[0] || {};
  ok('Suggest creates one task, with the product on it', mock.db.tasks.length === 1 && task.productsList.length === 1 && /Suggested value: 247 g/.test(task.description), task.title);
  ok('Suggest changes nothing on the product', mock.calls.every((c) => /^\/tasks/.test(c.path)));

  // Edit mode: a review first, then exactly one write.
  await lens.click(closeCard);
  await lens.click(lens.button('Edit'));
  await sleep(300);
  await lens.click(pill('Suggested'));
  await lens.waitFor(/New value/, 5000);
  const input = (await lens.all((n, tx, a) => (n.nodeName === 'INPUT' || n.nodeName === 'TEXTAREA') && a['data-field'] === 'edit'))[0];
  await cdp.send('DOM.focus', { backendNodeId: input.backendNodeId });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('247');
  await lens.click(lens.button('Review change'));
  t = await lens.waitFor(/Save to the PIM/, 6000);
  const writes = () => mock.calls.filter((c) => !/^\/tasks/.test(c.path));
  ok('Edit shows what will change, in which language and where, before anything is saved', /→ \| 247 gr/.test(t) && /In (English, in )?Nordic Thread Demo on demo-ui\.test\.bluestonepim\.com/.test(t) && writes().length === 0);
  // A click on "Save" in the instant it appears (a double click that was meant for "Review") is not a decision.
  await lens.click(lens.button('Save to the PIM'));
  await sleep(600);
  ok('a click on Save the moment it appears does nothing', writes().length === 0);
  await sleep(ARMED);
  await lens.click(lens.button('Save to the PIM'));
  await lens.waitFor(/Saved to the PIM/, 8000);
  ok('Edit saves exactly one value', writes().length === 1 && writes()[0].path === '/products/book/attributes/b-weight' && writes()[0].body.value === '247');
  await lens.click(closeCard);

  // The side panel, from a count in the corner box.
  await lens.click((n, tx, a) => n.nodeName === 'BUTTON' && /chip/.test(a.class || '') && /from the PIM/.test(tx));
  await sleep(2500);
  const handed = await sw.evaluate(async () => {
    const s = await chrome.storage.session.get(['bsi:capture', 'bsi:panel-filter']);
    return { pairs: s['bsi:capture'] && s['bsi:capture'].page ? s['bsi:capture'].page.pairs.length : 0, filter: s['bsi:panel-filter'] && s['bsi:panel-filter'].status };
  });
  ok('a count opens the side panel with that part of the comparison', !/side panel did not open/.test(await lens.text()) && handed.pairs > 0 && handed.filter === 'match');

  // What the page itself can see of all this.
  const seen = await page.evaluate(() => {
    const host = document.querySelector('[data-bluestone-lens]');
    return { host: !!host, shadowRoot: host ? host.shadowRoot : 'none', text: host ? host.innerText : '' };
  });
  ok('the page cannot look inside the Lens', seen.host && seen.shadowRoot === null && seen.text === '');
}

async function restartsAndPageChanges({ lens, page, toggle, state }) {
  await toggle();
  await lens.waitFor(/10 from the PIM/, 15000);
  await lens.waitFor(/not compared yet/, 10000);

  // Chrome stops the background worker whenever it is idle. Stop it, then carry on.
  const list = async () => (await fetch('http://127.0.0.1:9333/json/list')).json();
  const worker = (await list()).find((t) => t.type === 'service_worker' && /background\.js/.test(t.url));
  const ws = new WebSocket((await (await fetch('http://127.0.0.1:9333/json/version')).json()).webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: worker.id } }));
  await sleep(1200);
  ws.close();
  ok('the background worker is stopped', (await list()).every((t) => t.type !== 'service_worker'));
  await lens.click(pill('Differs'));
  const t = await lens.waitFor(/Last changed|Suggested value/, 8000);
  ok('a pill still opens with its details', /In the PIM \| 240 gr/.test(t));
  await lens.click(closeCard);
  await lens.click(lens.button('Allow it'));
  await sleep(2500);
  ok('"Allow it" still reaches Chrome\'s question', !/Chrome only takes this from its own menu|Not allowed/.test(await lens.text()));

  // A shop that moves to another product without reloading the page, after the user clicked something.
  const moveTo = (file) => page.evaluate(async (f) => {
    const doc = new DOMParser().parseFromString(await (await fetch('/' + f)).text(), 'text/html');
    history.pushState({}, '', '/' + f);
    document.title = doc.title;
    document.head.querySelectorAll('script[type="application/ld+json"]').forEach((x) => x.remove());
    doc.head.querySelectorAll('script[type="application/ld+json"]').forEach((x) => document.head.append(x));
    document.body.replaceChildren(...doc.body.childNodes);
  }, file);
  await page.mouse.click(40, 300); // the user's click on a link
  await moveTo('index.html');
  await lens.waitFor(/Reading the page/, 6000).catch(() => null);
  const after = await lens.waitFor(/from the PIM|No product|Which product/, 12000);
  const name = ((after.match(/× \| ([^|]+) \| ↗/) || [])[1] || '').trim();
  ok('another product without a reload: the new page is read', name === 'Summer Cotton Dress, Blue, M', `now showing: ${name}`);
  // The page changing its own address, with no click from the user: no new comparison, a button instead.
  const before = state.requests.length;
  await moveTo('book.html');
  await lens.waitFor(/The page has changed since it was read/, 8000);
  await sleep(2500);
  ok('a page that changes its own address is not read again by itself', state.requests.filter((r, i) => i >= before && /bluestonepim/.test(r)).length === 0);
  await lens.click(lens.button('Read it again'));
  await lens.waitFor(/10 from the PIM/, 12000);
  ok('and "Read it again" reads it', true);

  // Off and on again.
  await toggle();
  await sleep(400);
  ok('switching off leaves the page clean', (await lens.root()) === null && (await page.evaluate(() => document.querySelectorAll('[data-bluestone-lens]').length)) === 0);
  await toggle();
  await lens.waitFor(/from the PIM|No product|Which product/, 12000);
  ok('and it switches on again', true);
}

async function signInAndOddPlaces(world) {
  const { lens, page, cdp, context, state, mock, toggle } = world;
  await toggle();
  let t = await lens.waitFor(/Sign in to Bluestone PIM/, 12000);
  ok('signed out: the Lens says so and links to both Test PIMs', /Open demo-ui\.test/.test(t) && /Open app\.test/.test(t));
  state.mocks['app.test.bluestonepim.com'] = mock; // the user signs in on app.test
  await lens.click(lens.button('Try again'));
  await lens.waitFor(/from the PIM/, 12000);
  const base = await world.sw.evaluate(async () => (await chrome.storage.local.get('bsi:base'))['bsi:base']);
  ok('"Try again" finds the PIM the user signed in to', base === 'https://app.test.bluestonepim.com');

  // Facts kept in a modal drawer, as on many shops.
  const showing = async () => (await lens.all(pill())).length;
  const closed = await showing();
  await page.getByRole('button', { name: 'Produktinformasjon' }).first().click();
  await sleep(2200);
  const open = await showing();
  const inDialog = await page.evaluate(() => !!document.querySelector('[data-bluestone-lens]').closest('dialog'));
  ok('facts in a modal drawer get their pills when it opens', open > closed && inDialog, `${closed} pills before, ${open} after`);
  await lens.click(pill('Differs'));
  await lens.waitFor(/Suggested value|New value/, 6000);
  ok('a pill inside the drawer opens its card', true);
  await page.keyboard.press('Escape');

  // What the extension remembers is out of reach of scripts that run in the page.
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');
  await sleep(300);
  const own = contexts.find((c) => c.auxData && c.auxData.type === 'isolated' && /chrome-extension/.test(`${c.name}${c.origin}`));
  const read = own
    ? (await cdp.send('Runtime.evaluate', { contextId: own.id, awaitPromise: true, returnByValue: true, expression: `chrome.storage.local.get(null).then((v) => 'readable: ' + Object.keys(v), (e) => 'refused: ' + e.message)` })).result.value
    : 'the Lens\'s own script context was not found';
  ok('scripts in the page cannot read what the extension remembers', /^refused/.test(read), read);

  // A page no extension may read.
  const browserPage = await context.newPage();
  await browserPage.goto('chrome://version');
  const mark = await world.sw.evaluate(async () => {
    const tab = (await chrome.tabs.query({ active: true })).sort((a, b) => b.id - a.id)[0];
    await showLens(tab, 'lens:toggle');
    await new Promise((r) => setTimeout(r, 500));
    return `${await chrome.action.getBadgeText({ tabId: tab.id })} ${await chrome.action.getTitle({ tabId: tab.id })}`;
  });
  ok('a browser page gets a clear "cannot read this page" mark', /^! The Lens cannot read this page/.test(mark));
  await browserPage.close();

  // The demo pages, in a copy of the extension that has them (the published one does not).
  if (require('fs').existsSync(require('path').join(L.ROOT, 'ext', 'demo', 'shop.html'))) {
    const demo = await context.newPage();
    await demo.goto(`chrome-extension://${world.sw.url().split('/')[2]}/demo/shop.html`);
    const demoLens = L.lensView(demo, await context.newCDPSession(demo));
    await world.sw.evaluate(async () => showLens((await chrome.tabs.query({ active: true })).sort((a, b) => b.id - a.id)[0], 'lens:toggle'));
    await demoLens.waitFor(/from the PIM|No product|Which product/, 12000);
    ok('the demo page starts the Lens too', true);
    await demo.close();
  }

  // A PIM that never answers.
  await page.bringToFront();
  state.hang = true;
  await lens.click(lens.button('⚙'));
  await lens.click(lens.button('Read the page again'));
  t = await lens.waitFor(/took too long|Could not reach|Sign in to/, 70000);
  ok('a PIM that never answers ends in a message, not an endless wait', /took too long/.test(t));
  state.hang = false;
  await lens.click(lens.button('Try again'));
  await lens.waitFor(/from the PIM/, 15000);
  ok('and "Try again" recovers', true);
}

async function pictures({ lens, toggle }) {
  await toggle();
  const t = await lens.waitFor(/Pictures:/, 15000);
  ok('pictures are compared inside the background worker', /Pictures: 1 from the PIM, 1 not in the PIM\. \| The PIM has 1 more/.test(t), (t.match(/Pictures:[^|]*\|?[^|]*/) || [''])[0]);
  await lens.click(pill('PIM'), 12);
  const card = await lens.waitFor(/Product picture/, 5000);
  const thumbs = await lens.all((n, tx, a) => n.nodeName === 'IMG' && /^data:image/.test(a.src || '') && !/logo/.test(a.class || ''));
  ok('the card shows the page\'s picture beside the PIM\'s', /Fri, front cover · 600 × 900 px/.test(card) && thumbs.length > 0);
}

async function signingOut({ lens, context, state, mock, toggle }) {
  const settings = (n, tx, a) => n.nodeName === 'BUTTON' && a['aria-label'] === 'Settings';
  const pimTabs = () => context.pages().filter((p) => /bluestonepim\.com/.test(p.url()));
  await toggle();
  await lens.waitFor(/from the PIM/, 12000);
  await lens.click(settings);
  let t = await lens.waitFor(/Signed in as/, 5000);
  ok('settings say who is signed in', /Signed in as Anna Berg\./.test(t));

  await lens.click(lens.button('Sign out'));
  t = await lens.waitFor(/Sign out of Bluestone PIM\?/, 5000);
  ok('signing out asks first, and says the PIM tabs are signed out too', /open PIM tabs are signed out too/.test(t));
  await sleep(ARMED);
  const tabsBefore = context.pages().length;
  await lens.click(lens.button('Sign out'));
  t = await lens.waitFor(/You are signed out of Bluestone PIM/, 25000);
  const asked = state.requests.filter((r) => /\/logout$|\/op\/session\/end/.test(r));
  ok('signing out goes to the PIM\'s sign-out address, then ends the shared sign-in',
    asked.join(' > ') === 'GET demo-ui.test.bluestonepim.com/logout > GET idp.test.bluestonepim.com/op/session/end > POST idp.test.bluestonepim.com/op/session/end/confirm', asked.join(' > '));
  ok('signed out: nothing from the PIM is left on the page, and the Lens offers to sign in', (await lens.all(pill())).length === 0 && /Open demo-ui\.test/.test(t) && /Try again/.test(t));
  await sleep(500);
  ok('the tab used for signing out is closed again', context.pages().length === tabsBefore && pimTabs().length === 0, `${context.pages().length} tabs, ${tabsBefore} before`);

  mock.signIn({ id: 'u-bo', name: 'Bo Lind' }); // someone else signs in to the PIM
  await lens.click(lens.button('Try again'));
  await lens.waitFor(/from the PIM/, 12000);
  await lens.click(settings);
  t = await lens.waitFor(/Signed in as/, 5000);
  ok('after another user signs in, the Lens works as that user', /Signed in as Bo Lind\./.test(t));

  // A PIM that keeps its session: the Lens does not claim otherwise.
  state.keepSession = true;
  await lens.click(lens.button('Sign out'));
  await lens.waitFor(/Sign out of Bluestone PIM\?/, 5000);
  await sleep(ARMED);
  await lens.click(lens.button('Sign out'));
  t = await lens.waitFor(/did not sign you out/, 25000);
  await sleep(800);
  ok('a PIM that keeps the session: the Lens says so and leaves the PIM open to sign out there',
    /click your name there, then Sign out/.test(t) && pimTabs().some((p) => p.url().startsWith('https://demo-ui.test.bluestonepim.com/')), pimTabs().map((p) => p.url()).join(', '));
}

(async () => {
  console.log(`Browser: ${L.CHROME}`);
  await scenario('Everyday use', {}, everydayUse);
  await scenario('Worker restarts and page changes', {}, restartsAndPageChanges);
  await scenario('Signing in, and odd places', { signedOut: true, page: 'book-drawer.html' }, signInAndOddPlaces);
  await scenario('Signing out, and in as someone else', {}, signingOut);
  await scenario('Pictures, once the image host is allowed', { allowHosts: ['http://img.shop.example/*'] }, pictures);
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
