const H = require('./dom-stub.js');
const { sandbox: S, logs, observers, makeEl, body } = H;

// A feed post: <article><div><img></div><a href="/u/p/CODE/"></a></article>
const article = makeEl('article');
const media = makeEl('div', { role: 'presentation' });
media.appendChild(makeEl('img', { src: 'https://cdn/x.jpg?ig_cache_key=MjYyNjQzNzA1MDQyNzgwMzk4Ng%3D%3D' }));
article.appendChild(media);
article.appendChild(makeEl('a', { href: '/someuser/p/Dcja237lhkA/' }));
body.appendChild(article);

const step = (n, v) => console.log(`${n.padEnd(42)} ${v}`);

// 1. metadata arrives from the page world
S.document.dispatchEvent(new S.CustomEvent('IG_AUDIO_FOUND', {
  detail: { shortcode: 'Dcja237lhkA', audioUrl: 'https://cdn/a.m4a', startTime: 12, duration: 30 },
}));

if (logs.some(l => l.startsWith('WARN'))) {
  console.log('AVISOS NA INJECAO:');
  logs.filter(l => l.startsWith('WARN')).forEach(l => console.log('   ' + l));
}
const player = article.querySelector('.ig-audio-player-container');
step('player injetado', !!player);
step('classe is-muted', player && player.classList.contains('is-muted'));
step('espiada (is-hinting) ativa', player && player.classList.contains('is-hinting'));

const entry = [...S.__t.activePlayers.values()][0];
step('audio comeca mudo', entry.audio.muted);
step('audio comeca pausado', entry.audio.paused);
step('volume = preferencia global', entry.audio.volume);

// 2. post becomes fully visible while muted -> must stay silent
const vis = observers.visibility;
const target = [...vis.targets][0];
vis.cb([{ target, boundingClientRect: { height: 500 },
          intersectionRect: { height: 500 }, rootBounds: { height: 800 } }]);
step('visivel + mudo -> continua pausado', entry.audio.paused);

// 3. user clicks the sound button
const btn = player.querySelector('.ig-audio-btn');
btn.fire('click');
step('apos clicar em ativar som -> tocando', !entry.audio.paused);
step('audio desmutado', !entry.audio.muted);
step('posicao no trecho (segStart=12)', entry.audio.currentTime);

// 4. click again -> silence
btn.fire('click');
step('apos mutar -> pausado', entry.audio.paused);

console.log('\nlogs:');
logs.forEach(l => console.log('   ' + l.replace(/https:\/\/\S+/, '<url>')));
