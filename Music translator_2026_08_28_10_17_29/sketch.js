/* ============================================================
   VOICE — Varg x Blawan x Eno
   p5.js + p5.sound (mikrofon/FFT) + Web Audio (syntese)
   ------------------------------------------------------------
   DET BÆRENDE PRINCIP er Enos: hver korstemme har sin EGEN
   langsomme cyklus, og perioderne er valgt så de ikke går op i
   hinanden (17, 23, 29, 31, 37, 41 sekunder). De falder derfor
   aldrig i samme mønster to gange, og fordi de toner ind og ud
   hver for sig, er der aldrig seks stemmer i luften på én gang.
   Det er dét, der gør det muligt at have mange lag uden mudder —
   ikke at skrue ned for dem.

   Vargs del er kulden og bredden: mol-harmonik der skifter meget
   langsomt, alt højpasset ud af bunden og skubbet langt tilbage
   i en lang rumklang.

   Blawans del er vægten: en ren sub, og en mættet drone med
   asymmetrisk forvrængning som bærer midten.

   KLIK = start      V = deskriptorer
   ============================================================ */

/* ---------- 1. KONFIGURATION ------------------------------- */

const CFG = {
  gateDb: 13, hardGate: -47, rangeDb: 20,
  squelch: 0.11, hysteresis: 0.55,
  /* Rumgulvet måles som MINIMUM over et vindue, ikke som en
     følger. En følger der kryber opad mod alt under gaten kan
     ratchette: hver pause løfter gulvet, gaten følger med, og
     efter få sekunder kan intet komme igennem.                  */
  floorWin: 900,       // frames i vinduet (ca. 15 sek.) — langt nok
                       // til at fange rigtig stilhed mellem sætninger
  floorTrack: 0.020,   // hvor hurtigt gulvet følger vinduets minimum
  floorMin: -82, floorMax: -38,   // gulvet kan aldrig løbe over dette
  spillCap: 24,        // duplex-gaten må aldrig hæve mere end så meget
                       // over rumgulvet, uanset hvor højt vi selv spiller
  spillOffset: 16, blankMs: 70,
  transientDb: 7, fluxMin: 0.26, hitGap: 110,

  /* Kort release. En lang hale føles som noget der kører videre af
     sig selv — og så mister man fornemmelsen af at styre den.    */
  tailMs: 70,
  fallRate: 0.420,      // nedtur pr. frame
  tailDecay: 0.580,

  /* Lagene er fordelt: hvert lag har sin egen tærskel og sit eget
     register, så de kommer ind ét ad gangen i stedet for at ramme
     samtidig. Det er fordelingen — ikke lydstyrken — der gør at
     man kan høre dem hver for sig.                               */
  inSub:   0.00, octSub:  -12,
  inDeep:  0.02,
  inDrone: 0.06, octDrone:  0,
  inAir:   0.20,
  inChoir: 0.12, octChoir:  0,
  inLead:  0.40, octLead:  0,
  octDrone2: -12,      // dronen en oktav ned — hovedstemmen skal ligge dybt
  inShim:  0.58, octShim: 24,

  subTop: 95,
  droneLo: 80,
  leadLo: 240,
  choirLo: 300,

  leadAt: 0.38, leadFull: 0.92,

  bellHz: 7000, bellQ: 0.9, bellDb: -6, bellExtra: -3,
  notchMix: 0.38,

  /* Uafhængige perioder i sekunder — indbyrdes primiske, så
     korstemmerne aldrig synkroniserer.                          */
  cycles: [7, 11, 13, 17, 19, 23],   // stadig indbyrdes primiske
  chordEvery: 14000,    // ms mellem harmoniske skift

  fftBins: 512, fftSmooth: 0.5,
  voiceLow: 55, voiceHigh: 1200,   // bredere: brummen til fløjt
  yinThresh: 0.16,                 // YIN's absolutte tærskel
  clarityMin: 0.50,

  /* Stemmelaget */
  vocBands: 16, vocLo: 170, vocHi: 7000,
  vocDepth: 30,        // hvor hårdt envelopen åbner bærebølgen
  vocPre: 4,           // forforstærkning før envelopefølgerne
  vocSmooth: 26,       // Hz på envelopens lavpas — højere = skarpere konsonanter
  duck: 0.00,          // ducking af resten. 0 = fra. Over ca. 0,2
                       // begynder den at skrue bunden ud af nummeret
  voiceLo: 260, voiceHi: 5200    // båndbegrænsning = feedback-sikring
};

/* ÉN tone pr. vokal — ikke akkorder. Seks stemmer der synger den
   SAMME tone i forskellige oktaver står renere og passer altid
   sammen; seks forskellige toner slås om de samme overtoner og
   bliver grumsede uanset hvor pænt de er stemt.                  */
const VOWEL_NOTE = [0, 3, 5, 7, 10];        // skalatrin over grundtonen
const CHOIR_OCT  = [0, 12, 0, 12, 24, 0];   // stemmernes oktavfordeling

const VOWELS = [
  { id:'U', f1:350, f2: 800, drive:2.6, q: 5.0, spread:0.6 },
  { id:'O', f1:500, f2: 900, drive:3.2, q: 6.5, spread:0.8 },
  { id:'A', f1:750, f2:1200, drive:3.9, q: 8.5, spread:1.0 },
  { id:'E', f1:520, f2:1900, drive:4.5, q:10.5, spread:1.3 },
  { id:'I', f1:300, f2:2300, drive:5.1, q:12.5, spread:1.6 }
];


/* ---------- 2. STATE --------------------------------------- */

let ac = null, started = false, micOK = false, showAll = false;

let mic, micFFT, fastAn, slowAn, anL, anR, outAn;
let fastWave, fastFreq, slowWave, slowFreq, waveL, waveR, waveOut;
let dec, yin, pitchHist = [], prevMag = null, stereoSeen = false;

const F = {
  db:-100, level:0, rms:0, smooth:0,
  onset:0, flux:0,
  f0:0, clarity:0, hz:110,
  centroid:0, bright:0.4,
  pan:0, stereo:false,
  flatness:0, noisiness:0,
  sustainMs:0, charge:0,
  zcr:0, jitter:0,
  vowel:'A', f1:0, f2:0,
  silent:true, silenceMs:0
};

let ampFloor = -55, ampOpen = false, prevDb = -100;
let dbHist = null, dbPtr = 0, stuckFrames = 0, runaway = 0, runawayTrim = 1;
let lastHitMs = 0, selfHits = [];
let preset = VOWELS[2], presetIdx = 2;
let keyRoot = 45, keyHold = 0, keyCand = 45;
let presence = 0, leadAmt = 0, snap = 0;
let chordIdx = 0, chordProg = 0;

let master, limiter, bellEq;
let dryBus, bedBus;
let revIn, revWet;
let noiseBuf;
let subOsc, subLP, subGain;
let pipSrc, pipExc, pipMix, pipGain, pipBP = [];
let bassOscs = [], bassLP, bassEnv, bassSat, bassCorpus, bassSum,
    bassAmp, bassBody, bassDuck, bassBank, deepGain;
let drBank, choirBank, airBank;
let drOsc, drNz, drTone, drNoise, drHP, drPre, drFilt, drSat, drF1, drF2, drPan, drGain, drDrive = 2.2;
let choir = [], choirHP, choirFilt, choirGain;
let airSrc, airFilt, airGain;
let leadOsc, leadFM, leadFMAmt, leadSoft, leadFilt, leadEnv, leadPitch;
let combIn, combDly, combFb, combMix, leadHard, leadRe;
let leadAmp, leadBody, leadLfoA, leadLfoB;
let leadBank, flange, flange2, leadPan, leadGain;
let shimOscs = [], shimGain;

let voiceIn, voiceBP, voiceSat, voiceBank, voiceGain;
// (visuelle variable deklareres i afsnit 8)
let vocCar, vocNoise, vocCarSum, vocPre, vocSum, vocSat, vocBank, vocGain, vocBands = [];

/* Faste værdier. Der er ingen kontroller — stemmen er det eneste
   der rører lyden.                                              */
const MIX = {
  master: 0.92, sub: 0.30, deep: 0.42, drone: 0.34, choir: 0.46,
  lead: 0.26, air: 0.10, voice: 0.00, voc: 0.62,
  drive: 1.25, verb: 0.75, sweep: 1.60, fmod: 1.70, release: 1.00
};


/* ---------- 3. SETUP / LOOP -------------------------------- */

function setup() {
  createCanvas(windowWidth, windowHeight);
  // Feedback-sloejfen tegner hele laerredet tilbage paa sig selv
  // hver frame. Fuld pixeltaethed firedobler den omkostning, og
  // sloeret goer oploesningen ligegyldig alligevel.
  pixelDensity(1);
  textFont('Helvetica');
  makeSprites();
  background(0);
}
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  scene = null;                 // bufferne genskabes i draw
  background(0);
}

function mousePressed() {
  if (started) return;
  userStartAudio();
  guardAudioParams();
  ac = getAudioContext();
  buildGraph();
  startMic();
  started = true;
}
function keyPressed() { if (key === 'v' || key === 'V') showAll = !showAll; }

function draw() {
  if (started) { analyse(); updateVoices(); }
  drawField();
  drawHUD();
  snap *= 0.92;
}

/* SIKKERHEDSNET PÅ AudioParam
   Renser jeg deskriptorerne, burde der ikke komme NaN igennem —
   men grafen har over hundrede parameterkald, og ét enkelt sted
   med en division der lige akkurat kan give nul, vælter hele
   lydmotoren med en exception midt i draw().

   Derfor pakkes de fire tidsplanlægningsmetoder ind én gang: en
   ikke-endelig værdi erstattes af parameterens nuværende, og der
   skrives ÉN advarsel pr. metode til konsollen, så kilden kan
   findes i stedet for bare at blive dækket over.

   exponentialRampToValueAtTime skal have en fallback der er
   strengt positiv — nul kaster i sig selv.                      */
function guardAudioParams() {
  const P = window.AudioParam && AudioParam.prototype;
  if (!P || P.__guarded) return;
  P.__guarded = true;

  const warned = new Set();
  const wrap = (name, expo) => {
    const orig = P[name];
    if (!orig) return;
    P[name] = function (...a) {
      if (!Number.isFinite(a[0])) {
        if (!warned.has(name)) {
          warned.add(name);
          console.warn('[voice] ikke-endelig værdi til ' + name + ':', a[0]);
        }
        const cur = Number.isFinite(this.value) ? this.value : 0;
        a[0] = expo ? (Math.abs(cur) > 1e-5 ? cur : 0.0001) : cur;
      } else if (expo && Math.abs(a[0]) < 1e-6) {
        a[0] = a[0] < 0 ? -1e-6 : 1e-6;      // exponentiel rampe kan ikke ramme nul
      }
      for (let i = 1; i < a.length; i++) {
        if (!Number.isFinite(a[i]) || a[i] < 0) a[i] = 0;
      }
      if (name === 'setTargetAtTime' && !(a[2] > 0)) a[2] = 0.001;
      return orig.apply(this, a);
    };
  };

  wrap('setValueAtTime', false);
  wrap('linearRampToValueAtTime', false);
  wrap('exponentialRampToValueAtTime', true);
  wrap('setTargetAtTime', false);
}

/* ---------- 4. LYDGRAFEN ----------------------------------- */

function buildGraph() {
  limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -9; limiter.knee.value = 10; limiter.ratio.value = 8;
  limiter.attack.value = 0.008; limiter.release.value = 0.4;
  limiter.connect(ac.destination);

  /* Bell'en tager skarpheden omkring 7k; shelven tager alt over
     9k. To forskellige problemer: bell'en rammer resonanser,
     shelven rammer bredbåndet hvæs — en bell kan ikke gøre begge
     dele uden at æde hele toppen.                               */
  const airShelf = ac.createBiquadFilter();
  airShelf.type = 'highshelf';
  airShelf.frequency.value = 9000;
  airShelf.gain.value = -5;
  airShelf.connect(limiter);

  const midScoop = ac.createBiquadFilter();
  midScoop.type = 'peaking';
  midScoop.frequency.value = 700;
  midScoop.Q.value = 0.8;
  midScoop.gain.value = -4;
  midScoop.connect(airShelf);

  bellEq = ac.createBiquadFilter();
  bellEq.type = 'peaking';
  bellEq.frequency.value = CFG.bellHz;
  bellEq.Q.value = CFG.bellQ;
  bellEq.gain.value = CFG.bellDb;
  bellEq.connect(midScoop);

  master = ac.createGain(); master.gain.value = MIX.master;
  master.connect(bellEq);

  dryBus = ac.createGain(); dryBus.gain.value = 1;
  dryBus.connect(master);

  /* Alt UNDTAGEN stemmen går gennem bedBus, så den kan skrues ned
     når du taler. Uden en sådan ducking skal stemmen kæmpe mod
     otte lag i samme frekvensområde, og så kan man skrue den nok
     så meget op uden at den kommer FOREST — den bliver bare højere
     sammen med resten.                                           */
  bedBus = ac.createGain(); bedBus.gain.value = 1;
  bedBus.connect(dryBus);

  /* Lang rumklang, højpasset. Uden højpasset fylder halen bunden
     med tåge og æder al vægten fra sub og drone.                */
  const conv = ac.createConvolver();
  conv.buffer = makeImpulse(0.9, 3.8);
  const rhp = ac.createBiquadFilter();
  rhp.type = 'highpass'; rhp.frequency.value = 260;
  const rlp = ac.createBiquadFilter();
  rlp.type = 'lowpass'; rlp.frequency.value = 4200;
  revWet = ac.createGain(); revWet.gain.value = 0.16;
  revIn = ac.createGain(); revIn.gain.value = 1;
  revIn.connect(rhp); rhp.connect(rlp); rlp.connect(conv);
  conv.connect(revWet); revWet.connect(master);

  noiseBuf = makeNoise(4.0);
  buildSub(); buildBass(); buildPip(); buildDrone(); buildChoir(); buildLead(); buildShimmer();
  buildVoice();

  outAn = ac.createAnalyser(); outAn.fftSize = 1024;
  limiter.connect(outAn);
  waveOut = new Float32Array(outAn.fftSize);
}

/* NOTCH-BANK PR. ELEMENT
   Fire til seks hak i serie inde i hver stemmes egen kæde. Fordi
   de kun rammer ét lag ad gangen, huler de ikke helheden ud, som
   én stor bank på masteren gjorde — og fordi hvert lag har sin
   egen, bevæger lagene sig indbyrdes forskelligt.

   Hakkene ligger log-fordelt over elementets eget område. Hvert
   hak har sin egen deskriptor, sin egen langsomme LFO og sin egen
   retning, så de aldrig fejer parallelt.                        */
function makeBank(count, lo, hi, srcs) {
  const input = ac.createGain(), nodes = [];
  let node = input;
  for (let i = 0; i < count; i++) {
    const f = ac.createBiquadFilter();
    f.type = 'notch';
    f.frequency.value = lo * Math.pow(hi/lo, i/(count-1));
    f.Q.value = 3;
    node.connect(f); node = f;
    nodes.push({
      node: f,
      base: lo * Math.pow(hi/lo, i/(count-1)),
      src: srcs[i % srcs.length],
      rate: 0.017 + i*0.019,
      dir: i % 2 ? 1 : -1
    });
  }
  return { input, output: node, nodes };
}

/* span er hvor mange gange op og ned et hak må flytte sig. Høje
   værdier er hele pointen her: hakkene skal FEJE, ikke vippe.   */
function updateBank(bank, now, span, q) {
  for (const n of bank.nodes) {
    const v = notchVal(n.src);
    const lfo = Math.sin(now*TWO_PI*n.rate + n.base) * 0.16;
    const f = n.base * Math.pow(span, ((v - 0.5)*2*n.dir) + lfo);
    n.node.frequency.setTargetAtTime(constrain(f, 35, 16000), now, 0.018);
    n.node.Q.setTargetAtTime(q, now, 0.06);
  }
}

function buildSub() {
  subOsc = ac.createOscillator(); subOsc.type = 'sine';
  subLP = ac.createBiquadFilter();
  subLP.type = 'lowpass'; subLP.frequency.value = CFG.subTop; subLP.Q.value = 0.7;
  // Mætning EFTER lavpasset: overtonerne skabes bagefter og
  // overlever, så bunden kan høres på små højttalere i stedet for
  // kun at kunne mærkes på store.
  const subSat = ac.createWaveShaper();
  subSat.curve = tubeCurve(1.5, 0.12);
  subSat.oversample = '2x';
  subGain = ac.createGain(); subGain.gain.value = 0;
  subOsc.connect(subLP); subLP.connect(subSat);
  subSat.connect(subGain); subGain.connect(bedBus);
  subOsc.start();
}

/* DRONEN bærer midten. Sav og støj krydsfades ind i ét lavpas og
   køres gennem asymmetrisk mætning. Q er holdt lavt — det var det
   høje Q der gjorde den skarp; vægten kommer fra forvrængningen,
   ikke fra resonansen.                                          */
/* BASSEN
   Firkant med en anelse trekant blandet i, lavpasset omkring
   200-800 Hz med moderat resonans og derefter hårdt mættet.
   Firkanten har kun ulige overtoner og fylder derfor et andet
   sted end alle savtakkerne — det er dét, der gør at den kan
   ligge højt uden at maskere.

   Kroppen kommer fra en "corpus": et enkelt meget smalt båndpas
   stemt til tonen, blandet ind på under en tiendedel. Det skal
   ikke høres som en effekt, kun mærkes som at lyden har et
   legeme. Hæver man den, bliver det til en klokke.

   Mono, og duckes af hvert anslag.                              */
function buildBass() {
  bassLP = ac.createBiquadFilter();
  bassLP.type = 'lowpass'; bassLP.frequency.value = 300; bassLP.Q.value = 4;
  bassEnv = ac.createConstantSource(); bassEnv.offset.value = 0;
  bassEnv.connect(bassLP.frequency); bassEnv.start();

  bassSat = ac.createWaveShaper();
  bassSat.curve = tubeCurve(5.0, 0.20); bassSat.oversample = '4x';

  bassSum = ac.createGain(); bassSum.gain.value = 1;
  bassAmp = ac.createGain(); bassAmp.gain.value = 0.0001;
  bassBody = ac.createGain(); bassBody.gain.value = 0;
  bassDuck = ac.createGain(); bassDuck.gain.value = 1;
  deepGain = ac.createGain(); deepGain.gain.value = 0;

  bassLP.connect(bassSat); bassSat.connect(bassSum);

  // Corpus: smal resonans stemt til tonen, blandet meget lavt
  bassCorpus = ac.createBiquadFilter();
  bassCorpus.type = 'bandpass'; bassCorpus.frequency.value = 110; bassCorpus.Q.value = 26;
  const cg = ac.createGain(); cg.gain.value = 0.085;
  bassSat.connect(bassCorpus); bassCorpus.connect(cg); cg.connect(bassSum);

  bassSum.connect(bassAmp); bassAmp.connect(bassBody);
  bassBody.connect(bassDuck); bassDuck.connect(deepGain);
  deepGain.connect(bedBus);                       // mono, uden om rum og notches

  const types = ['square', 'square', 'triangle'];
  const gains = [0.5, 0.28, 0.16];
  for (let i = 0; i < 3; i++) {
    const o = ac.createOscillator();
    o.type = types[i];
    o.detune.value = [0, 7, -5][i];
    const g = ac.createGain(); g.gain.value = gains[i];
    o.connect(g); g.connect(bassLP); o.start();
    bassOscs.push({ osc: o, iv: [0, 0, 0][i] });
  }

  bassBank = makeBank(6, 45, 420, ['level','pitch','jitter','charge','bright','f1']);
}

/* Kun tre toner: grundtone, kvint, oktav. Hvilken vælges af hvor
   din stemme ligger. Få toner er hele pointen — en bas der følger
   hver eneste bevægelse i stemmen holder ikke bunden.            */
/* Grundtone, kvint og oktav — men i DIN oktav. Der soeges over
   flere oktaver og vaelges den naermeste, hvorefter resultatet
   foldes ned i basleje. Saa er der stadig kun tre toner, men de
   flytter sig med dig i stedet for at staa fast.                */
function bassNoteFor(m) {
  const deg = [0, 7, 12];
  let best = keyRoot, bd = 999;
  for (let oct = -2; oct <= 3; oct++)
    for (const d of deg) {
      const c = keyRoot + d + oct*12;
      const dd = Math.abs(c - m);
      if (dd < bd) { bd = dd; best = c; }
    }
  while (best > 54) best -= 12;
  while (best < 28) best += 12;
  return best;
}

function bassNote(t, vel) {
  const pick = bassNoteFor(freqToMidi(constrain(F.hz, 40, 900)) - 12);
  const hz = midiToFreq(pick);
  for (const b of bassOscs) b.osc.frequency.setTargetAtTime(hz, t, 0.008);
  bassCorpus.frequency.setTargetAtTime(hz * 2, t, 0.02);

  // Auto-filter: velocity åbner cutoff, langsom envelope lukker
  const e = bassEnv.offset;
  e.cancelScheduledValues(t);
  e.setValueAtTime(0, t);
  e.linearRampToValueAtTime(240 + vel*620, t + 0.010);
  e.linearRampToValueAtTime(0, t + 0.20 + vel*0.45);

  const g = bassAmp.gain;
  const dec = 0.12 + vel*0.26;                    // decay 120-380 ms
  g.cancelScheduledValues(t);
  g.setValueAtTime(0.0001, t);
  g.linearRampToValueAtTime(0.7 + vel*0.3, t + 0.001);   // attack 0
  g.exponentialRampToValueAtTime(0.30, t + dec);

  // Sidechain: bassen viger for sit eget anslag
  const d = bassDuck.gain;
  d.cancelScheduledValues(t);
  d.setValueAtTime(0.35, t);
  d.linearRampToValueAtTime(1, t + 0.14 + vel*0.10);
}

/* PIP-RESONANSEN
   To meget smalle baandpas stemt til et hoejt, ikke-heltalligt
   multiplum af din tone. Heltal ville give en overtone, som
   forsvinder ind i klangen; 7,02 og 10,93 giver noget der IKKE
   hoerer til i harmonikken, og det er derfor det stikker ud som
   et pip frem for at smelte sammen.

   De exciteres af stoej: et kort stoed paa hvert anslag, plus en
   meget svag konstant tilfoersel mens du taler. Det er den samme
   mekanik som en anslaaet metalplade — hvid stoej ind i en hoej-Q
   resonans, og den ringer paa sin egen frekvens.

   Den skal ligge lavt. Hoeres den tydeligt, er den for hoej.    */
function buildPip() {
  pipExc = ac.createGain(); pipExc.gain.value = 0;
  pipMix = ac.createGain(); pipMix.gain.value = 0.5;
  pipGain = ac.createGain(); pipGain.gain.value = 0;

  const ratios = [7.02, 10.93];
  for (let i = 0; i < 2; i++) {
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 38;
    const g = ac.createGain(); g.gain.value = i ? 0.55 : 1;
    const pan = ac.createStereoPanner(); pan.pan.value = i ? 0.4 : -0.35;
    pipExc.connect(bp); bp.connect(g); g.connect(pan); pan.connect(pipMix);
    pipBP.push({ bp, ratio: ratios[i] });
  }

  pipMix.connect(pipGain);
  pipGain.connect(bedBus);          // toert, uden om rum og notches

  pipSrc = ac.createBufferSource();
  pipSrc.buffer = noiseBuf; pipSrc.loop = true;
  pipSrc.connect(pipExc); pipSrc.start();
}

// Anslaget slaar paa pladen
function pipStrike(t, vel) {
  const g = pipExc.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(0.0001, t);
  g.linearRampToValueAtTime(0.20 + vel*0.55, t + 0.002);
  g.exponentialRampToValueAtTime(0.004, t + 0.05 + vel*0.05);
}

function buildDrone() {
  drHP = ac.createBiquadFilter();
  drHP.type = 'highpass'; drHP.frequency.value = 70;
  drFilt = ac.createBiquadFilter();
  drFilt.type = 'lowpass'; drFilt.frequency.value = 500; drFilt.Q.value = 4;
  drSat = ac.createWaveShaper();
  drSat.curve = tubeCurve(drDrive); drSat.oversample = '4x';
  drPan = ac.createStereoPanner();
  drGain = ac.createGain(); drGain.gain.value = 0;

  /* To toppe der sporer DINE formanter, placeret EFTER mætningen.
     Rækkefølgen er talkboxens: først laves der et tæt overtone-
     spektrum, derefter skæres vokalen ud af det. Det er dét, der
     gør at synthen siger din vokal tilbage i stedet for bare at
     skifte klangfarve.                                          */
  drF1 = ac.createBiquadFilter();
  drF1.type = 'peaking'; drF1.frequency.value = 600; drF1.Q.value = 5; drF1.gain.value = 9;
  drF2 = ac.createBiquadFilter();
  drF2.type = 'peaking'; drF2.frequency.value = 1400; drF2.Q.value = 6; drF2.gain.value = 7;

  // Drive FØR filteret også: filteret former så forvrængningen i
  // stedet for omvendt, og det er dét, der giver den kompakte,
  // gummiagtige midte frem for en filtreret sav med et lag ovenpå.
  drPre = ac.createWaveShaper();
  drPre.curve = tubeCurve(2.4, 0.22);
  drPre.oversample = '2x';
  drHP.connect(drPre); drPre.connect(drFilt); drFilt.connect(drSat);
  drBank = makeBank(10, 90, 5000,
    ['bright','level','f1','pitch','noisiness','f2','charge','jitter','level','bright']);
  drSat.connect(drF1); drF1.connect(drF2); drF2.connect(drBank.input);
  drBank.output.connect(drPan); drPan.connect(drGain);
  drGain.connect(bedBus);

  drTone = ac.createGain(); drTone.gain.value = 1;
  drNz   = ac.createGain(); drNz.gain.value = 0;
  // Støjen får sit eget lavpas, så den er ånde og ikke hvæs. Uden
  // det trak den hele dronen mod støj, og støj er det der gjorde
  // helheden noisy.
  const drNzLP = ac.createBiquadFilter();
  drNzLP.type = 'lowpass'; drNzLP.frequency.value = 900; drNzLP.Q.value = 0.6;
  drTone.connect(drHP);
  drNz.connect(drNzLP); drNzLP.connect(drHP);

  drOsc = ac.createOscillator(); drOsc.type = 'sawtooth';
  drOsc.connect(drTone); drOsc.start();

  drNoise = ac.createBufferSource();
  drNoise.buffer = noiseBuf; drNoise.loop = true;
  drNoise.connect(drNz); drNoise.start();
}

/* KORET — kernen i det hele. Seks stemmer, hver med sin egen
   periode og sin egen faseforskydning. De toner ind og ud
   uafhængigt, så mixet aldrig indeholder alle seks samtidig, og
   kombinationen gentager sig først efter mange minutter.        */
function buildChoir() {
  choirHP = ac.createBiquadFilter();
  choirHP.type = 'highpass'; choirHP.frequency.value = CFG.choirLo;
  choirFilt = ac.createBiquadFilter();
  choirFilt.type = 'lowpass'; choirFilt.frequency.value = 1200; choirFilt.Q.value = 1.2;
  choirGain = ac.createGain(); choirGain.gain.value = 0;

  choirBank = makeBank(8, 200, 7000,
    ['charge','bright','pitch','jitter','level','f2','noisiness','f1']);
  choirHP.connect(choirFilt); choirFilt.connect(choirBank.input);
  choirBank.output.connect(choirGain);
  choirGain.connect(bedBus); choirGain.connect(revIn);

  for (let i = 0; i < CFG.cycles.length; i++) {
    const o = ac.createOscillator();
    o.type = i % 2 ? 'sawtooth' : 'triangle';
    o.detune.value = [-11, -5, 3, 8, -7, 12][i];
    const g = ac.createGain(); g.gain.value = 0;
    const p = ac.createStereoPanner();
    p.pan.value = [-0.7, 0.5, -0.3, 0.75, 0.1, -0.55][i];
    o.connect(g); g.connect(p); p.connect(choirHP); o.start();
    choir.push({ osc: o, gain: g, pan: p,
                 period: CFG.cycles[i], ph: i * 0.37, iv: i });
  }
}

/* STEMMELAGET: din egen stemme oven i, gennem en vocoder.

   Vocoderen er ægte og kører i audio-rate — ingen ScriptProcessor.
   Kunsten er envelopefølgeren: en WaveShaper med kurven |x|
   ensretter båndet, og et lavpas ved 18 Hz glatter det til en
   ren styringsspænding. Den spænding sendes ind i gain-parameteren
   på det TILSVARENDE bånd af bærebølgen, hvis egen værdi står på
   nul — så er det udelukkende din stemme, der åbner båndet.

   Fjorten bånd, log-fordelt fra 180 Hz til 6 kHz. Bærebølgen er
   en sav på sangtonen plus lidt støj: saven bærer vokalerne,
   støjen gør konsonanterne læselige. Uden støjen forsvinder alle
   s'er og t'er, fordi en sav ikke har energi dér.

   FEEDBACK: stemmevejen er gatet af den samme gate som resten og
   båndbegrænset til 260-5200 Hz. Rumlen og hvæsen er dét, der
   løber løbsk først, og de er skåret væk. Brug alligevel
   hovedtelefoner.                                               */
function buildVoice() {
  voiceIn = ac.createGain(); voiceIn.gain.value = 0;

  const hp = ac.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = CFG.voiceLo;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = CFG.voiceHi;
  voiceIn.connect(hp); hp.connect(lp);
  voiceBP = lp;

  /* Den tørre stemme: hårdt mættet og gennem sin egen lille bank,
     så det er GENKENDELIGT dig, men aldrig ren mikrofon.         */
  voiceSat = ac.createWaveShaper();
  voiceSat.curve = tubeCurve(3.2, 0.16);
  voiceSat.oversample = '2x';
  voiceBank = makeBank(4, 320, 5000, ['bright','jitter','f2','level']);
  vocBank = makeBank(8, 200, 7500,
    ['bright','f1','jitter','level','f2','noisiness','charge','pitch']);
  voiceGain = ac.createGain(); voiceGain.gain.value = 0;
  voiceBP.connect(voiceSat); voiceSat.connect(voiceBank.input);
  voiceBank.output.connect(voiceGain);
  voiceGain.connect(dryBus); voiceGain.connect(revIn);

  /* Bærebølgen */
  /* Forforstærkning før envelopefølgerne. Et enkelt bånd af en
     rå mikrofon ligger typisk omkring 0,01-0,05 i amplitude, og
     ensrettet og glattet bliver det til nogle få tusindedele —
     alt for lidt til at åbne en gain-parameter. Uden dette trin
     kan man skrue vocDepth i vejret i det uendelige uden at høre
     andet end en antydning.                                      */
  vocPre = ac.createGain(); vocPre.gain.value = CFG.vocPre;
  voiceBP.connect(vocPre);

  vocCarSum = ac.createGain(); vocCarSum.gain.value = 0.75;
  vocCar = ac.createOscillator(); vocCar.type = 'sawtooth';
  const cg = ac.createGain(); cg.gain.value = 0.85;
  vocCar.connect(cg); cg.connect(vocCarSum); vocCar.start();

  vocNoise = ac.createBufferSource();
  vocNoise.buffer = noiseBuf; vocNoise.loop = true;
  const ng = ac.createGain(); ng.gain.value = 0.17;
  vocNoise.connect(ng); ng.connect(vocCarSum); vocNoise.start();

  vocSum = ac.createGain(); vocSum.gain.value = 1;
  vocSat = ac.createWaveShaper();
  vocSat.curve = tubeCurve(3.4, 0.20);
  vocSat.oversample = '2x';
  vocGain = ac.createGain(); vocGain.gain.value = 0;

  // Egen kompressor: seksten bånd der åbner samtidig på en
  // konsonant kan summere langt over det de gør hver for sig
  const vocComp = ac.createDynamicsCompressor();
  vocComp.threshold.value = -18; vocComp.knee.value = 8;
  vocComp.ratio.value = 8; vocComp.attack.value = 0.004; vocComp.release.value = 0.15;

  vocSum.connect(vocComp); vocComp.connect(vocSat); vocSat.connect(vocBank.input);
  vocBank.output.connect(vocGain);
  vocGain.connect(dryBus);

  // Ensretterkurven: fuldbølge |x|
  const rect = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) rect[i] = Math.abs((i/1023)*2 - 1);

  const N = CFG.vocBands;
  for (let i = 0; i < N; i++) {
    const f = CFG.vocLo * Math.pow(CFG.vocHi/CFG.vocLo, i/(N-1));
    const q = 5 + i*0.35;

    const bm = ac.createBiquadFilter();
    bm.type = 'bandpass'; bm.frequency.value = f; bm.Q.value = q;
    const r = ac.createWaveShaper(); r.curve = rect;
    const sm = ac.createBiquadFilter();
    sm.type = 'lowpass'; sm.frequency.value = CFG.vocSmooth; sm.Q.value = 0.6;
    const depth = ac.createGain(); depth.gain.value = CFG.vocDepth;

    const bc = ac.createBiquadFilter();
    bc.type = 'bandpass'; bc.frequency.value = f; bc.Q.value = q;
    const vca = ac.createGain(); vca.gain.value = 0;   // KUN stemmen åbner den

    vocPre.connect(bm); bm.connect(r); r.connect(sm);
    sm.connect(depth); depth.connect(vca.gain);
    vocCarSum.connect(bc); bc.connect(vca); vca.connect(vocSum);

    vocBands.push({ bm, bc, depth, f, q });
  }
}

function startAir() {
  airFilt = ac.createBiquadFilter();
  airFilt.type = 'bandpass'; airFilt.frequency.value = 1800; airFilt.Q.value = 1.6;
  airGain = ac.createGain(); airGain.gain.value = 0;
  airBank = makeBank(6, 600, 9500, ['noisiness','jitter','bright','f2','level','charge']);
  airFilt.connect(airBank.input); airBank.output.connect(airGain);
  airGain.connect(bedBus); airGain.connect(revIn);
  airSrc = ac.createBufferSource();
  airSrc.buffer = noiseBuf; airSrc.loop = true;
  airSrc.connect(airFilt); airSrc.start();
}

/* LEADET
   Én saw med FM, index 2-5. Kæden er: FM-oscillator -> blød
   clipper -> resonant lavpas -> COMB -> hård waveshaper ->
   notch-bank -> envelope.

   COMB'en er en kort forsinkelse med 94-97% tilbagekobling, stemt
   til grundtone + oktav. Det er ikke en delayeffekt: forsinkelsen
   er kortere end en enkelt svingning, så gentagelserne smelter
   sammen til en resonans i stedet for at høres som ekkoer. Det er
   dét, der giver den metalliske, næsten stemte krop.

   Rækkefølgen blød-før-hård er ikke ligegyldig: den bløde clipper
   runder toppene af, så den hårde waveshaper har noget afrundet at
   bide i og ikke bare firkanter alt. Omvendt rækkefølge giver
   digital fizz.

   Til sidst køres signalet gennem ET TRIN MERE af samme slags —
   det er resamplingen: det allerede behandlede signal behandles
   igen, og det er dér lyden holder op med at lyde som en synth.  */
function buildLead() {
  // --- Oscillator: saw + FM
  leadOsc = ac.createOscillator(); leadOsc.type = 'sawtooth';
  leadFM  = ac.createOscillator(); leadFM.type = 'sine';
  leadFMAmt = ac.createGain(); leadFMAmt.gain.value = 0;
  leadFM.connect(leadFMAmt); leadFMAmt.connect(leadOsc.frequency);

  // --- Blød clipper først
  leadSoft = ac.createWaveShaper();
  leadSoft.curve = tubeCurve(1.7, 0.10); leadSoft.oversample = '2x';

  // --- Resonant lavpas med egen envelope
  leadFilt = ac.createBiquadFilter();
  leadFilt.type = 'lowpass'; leadFilt.frequency.value = 400; leadFilt.Q.value = 12;
  leadEnv = ac.createConstantSource(); leadEnv.offset.value = 0;
  leadEnv.connect(leadFilt.frequency); leadEnv.start();

  leadPitch = ac.createConstantSource(); leadPitch.offset.value = 0;
  leadPitch.connect(leadOsc.detune); leadPitch.start();

  // --- COMB (Belgrad): forsinkelse kortere end én svingning
  combDly = ac.createDelay(0.05);
  combDly.delayTime.value = 1/110;
  combFb = ac.createGain(); combFb.gain.value = 0.88;

  const combLP = ac.createBiquadFilter();
  combLP.type = 'lowpass'; combLP.frequency.value = 3200;

  /* MÆTNING INDE I SLØJFEN. Det er dette trin, der gør resonatoren
     brugbar. En ren tilbagekobling på 0,9+ med konstant tilførsel
     er matematisk ustabil: hver omgang lægger mere til end der
     forsvinder, og efter nogle sekunder er signalet astronomisk.
     Limiteren pinder, duplex-gaten ser en permanent høj udgang og
     lukker — og så er der stille.

     En tanh i sløjfen sætter et loft: jo kraftigere signalet
     bliver, jo mere komprimeres det pr. omgang, og sløjfen finder
     et stabilt niveau i stedet for at løbe væk. Det er præcis
     sådan en analog resonator opfører sig, og det er derfor de kan
     køre på kanten af selvsving uden at eksplodere.              */
  const combSat = ac.createWaveShaper();
  combSat.curve = tubeCurve(1.6, 0);   // symmetrisk: bias 0
  combSat.oversample = '2x';

  combIn = ac.createGain(); combIn.gain.value = 0.7;
  combIn.connect(combDly);
  combDly.connect(combLP); combLP.connect(combSat);
  combSat.connect(combFb); combFb.connect(combDly);
  combMix = ac.createGain(); combMix.gain.value = 0.55;
  combDly.connect(combMix);
  combIn.connect(combMix);                                  // tørt + resonans

  // --- Hård waveshaper efter den bløde
  leadHard = ac.createWaveShaper();
  leadHard.curve = tubeCurve(4.5, 0.22); leadHard.oversample = '4x';

  // --- Morpheus: notch-bank med meget langsom fejning
  leadBank = makeBank(12, 150, 9500,
    ['bright','charge','f2','level','jitter','f1','pitch','noisiness',
     'bright','level','charge','f2']);

  // --- Envelope og krop
  leadAmp  = ac.createGain(); leadAmp.gain.value = 0.0001;   // anslaget
  leadBody = ac.createGain(); leadBody.gain.value = 0;       // det holdte

  flange = makeFlanger();
  flange2 = makeFlanger(0.0026, 0.0018, 0.31);
  leadPan = ac.createStereoPanner();
  leadGain = ac.createGain(); leadGain.gain.value = 0;

  leadOsc.connect(leadSoft); leadSoft.connect(leadFilt);
  leadFilt.connect(combIn);
  combMix.connect(leadHard); leadHard.connect(leadBank.input);
  leadBank.output.connect(flange.input);
  flange.output.connect(flange2.input);

  // --- Andet gennemløb: resampling-tanken
  leadRe = ac.createWaveShaper();
  leadRe.curve = tubeCurve(2.2, 0.14); leadRe.oversample = '2x';
  const reFilt = ac.createBiquadFilter();
  reFilt.type = 'lowpass'; reFilt.frequency.value = 4000; reFilt.Q.value = 3;
  flange2.output.connect(leadRe); leadRe.connect(reFilt);

  reFilt.connect(leadAmp); leadAmp.connect(leadBody);
  leadBody.connect(leadPan); leadPan.connect(leadGain);
  leadGain.connect(bedBus);

  // --- To usynkroniserede LFO'er
  leadLfoA = ac.createOscillator(); leadLfoA.frequency.value = 0.17;
  const aAmt = ac.createGain(); aAmt.gain.value = 0.012;
  leadLfoA.connect(aAmt); aAmt.connect(combFb.gain); leadLfoA.start();

  leadLfoB = ac.createOscillator(); leadLfoB.frequency.value = 0.023;
  const bAmt = ac.createGain(); bAmt.gain.value = 260;
  leadLfoB.connect(bAmt); bAmt.connect(leadFilt.frequency); leadLfoB.start();

  leadOsc.start(); leadFM.start();
}

/* Anslaget spiller en tone. Velocity er anslagets styrke og styrer
   både FM-index, filterets åbning og tonens længde — præcis som på
   en rigtig synth, hvor hårdere anslag giver lysere og længere
   toner.                                                          */
function leadNote(t, midi, vel) {
  const hz = midiToFreq(midi);

  // Lidt pitch-modulation: tonen falder på plads
  /* Tonefaldet ligger paa DETUNE i cents, ikke paa frekvensen.
     Frekvensen glider kontinuerligt med din stemme, og de to
     ville ellers overskrive hinandens automatisering.           */
  const dp = leadPitch.offset;
  dp.cancelScheduledValues(t);
  dp.setValueAtTime(vel * 850, t);
  dp.exponentialRampToValueAtTime(1, t + 0.05 + vel*0.06);

  // FM-oscillatorens frekvens styres loebende af sporingen; her
  // saettes kun indexet, saa de to ikke skriver til samme parameter
  const idx = 2 + vel*3;                       // FM-index 2-5
  leadFMAmt.gain.cancelScheduledValues(t);
  leadFMAmt.gain.setValueAtTime(hz * idx, t);
  leadFMAmt.gain.exponentialRampToValueAtTime(hz * 0.4, t + 0.12 + vel*0.2);

  // COMB stemt til grundtone + oktav
  // COMB stemt til DIN tone en oktav op, ikke til tonearten
  combDly.delayTime.setTargetAtTime(1 / constrain(hz, 40, 900), t, 0.02);

  const e = leadEnv.offset;
  e.cancelScheduledValues(t);
  e.setValueAtTime(0, t);
  e.linearRampToValueAtTime(700 + vel*3400, t + 0.006);
  e.linearRampToValueAtTime(0, t + 0.10 + vel*0.30);

  const g = leadAmp.gain;
  const dec = 0.08 + vel*0.24;                 // decay 80-320 ms
  g.cancelScheduledValues(t);
  g.setValueAtTime(0.0001, t);
  g.linearRampToValueAtTime(0.5 + vel*0.5, t + 0.002);   // attack 0
  g.exponentialRampToValueAtTime(0.28, t + dec);
}

/* Grundforsinkelsen SKAL være større end LFO'ens udsving, ellers
   klipper delayTime mod nul og fejningen flader ud i bunden.     */
function makeFlanger(base = 0.0042, dep = 0.0030, rate = 0.11) {
  const input = ac.createGain(), output = ac.createGain();
  const dly = ac.createDelay(0.05);
  const fb = ac.createGain(), wet = ac.createGain();
  const lfo = ac.createOscillator(), depth = ac.createGain();
  dly.delayTime.value = base;
  fb.gain.value = 0.55; wet.gain.value = 0.9;
  lfo.type = 'sine'; lfo.frequency.value = rate;
  depth.gain.value = dep;
  lfo.connect(depth); depth.connect(dly.delayTime); lfo.start();
  input.connect(output);
  input.connect(dly); dly.connect(wet); wet.connect(output);
  dly.connect(fb); fb.connect(dly);
  return { input, output, dly, fb, wet, lfo, depth };
}

// Oktaven over akkorden, KUN i rumklangen. Den glasagtige top
// uden at nogen af de hørbare stemmer bliver skinger.
function buildShimmer() {
  shimGain = ac.createGain(); shimGain.gain.value = 0;
  shimGain.connect(revIn);
  for (let i = 0; i < 3; i++) {
    const o = ac.createOscillator();
    o.type = 'triangle';
    o.detune.value = [-9, 5, 13][i];
    const g = ac.createGain(); g.gain.value = 0.3;
    o.connect(g); g.connect(shimGain); o.start();
    shimOscs.push(o);
  }
}

/* ---------- 5. ANALYSE ------------------------------------- */

function startMic() {
  mic = new p5.AudioIn();
  mic.start(
    () => {
      micFFT = new p5.FFT(CFG.fftSmooth, CFG.fftBins);
      micFFT.setInput(mic);

      fastAn = ac.createAnalyser();
      fastAn.fftSize = 512; fastAn.smoothingTimeConstant = 0;
      mic.connect(fastAn);                   // ALDRIG mic.connect() uden argument
      fastWave = new Float32Array(fastAn.fftSize);
      fastFreq = new Float32Array(fastAn.frequencyBinCount);

      slowAn = ac.createAnalyser();
      slowAn.fftSize = 2048; slowAn.smoothingTimeConstant = 0;
      mic.connect(slowAn);
      slowWave = new Float32Array(slowAn.fftSize);
      slowFreq = new Float32Array(slowAn.frequencyBinCount);

      const split = ac.createChannelSplitter(2);
      mic.output.connect(split);
      anL = ac.createAnalyser(); anL.fftSize = 512;
      anR = ac.createAnalyser(); anR.fftSize = 512;
      split.connect(anL, 0); split.connect(anR, 1);
      waveL = new Float32Array(anL.fftSize);
      waveR = new Float32Array(anR.fftSize);

      mic.connect(voiceIn);        // eneste sted mikrofonen når udgangen
      startAir();
      micOK = true;
    },
    () => { micOK = false; }
  );
}

/* constrain() slipper NaN igennem — Math.min(NaN, hi) er NaN, og
   så løber den uhindret ud i hver eneste AudioParam. Derfor renses
   alle deskriptorer ét sted, lige efter de er målt, i stedet for
   at forsøge at fange dem hundrede steder nede i grafen.        */
const F_DEFAULT = {
  db:-100, level:0, rms:0, smooth:0, onset:0, flux:0,
  f0:0, clarity:0, hz:110, centroid:1000, bright:0.4,
  pan:0, flatness:0.01, noisiness:0.3, sustainMs:0, charge:0,
  zcr:800, jitter:0.3, f1:600, f2:1400, silenceMs:0
};

function sanitise() {
  for (const k in F_DEFAULT) if (!Number.isFinite(F[k])) F[k] = F_DEFAULT[k];
  if (!Number.isFinite(presence)) presence = 0;
  if (!Number.isFinite(leadAmt))  leadAmt = 0;
  if (!Number.isFinite(snap))     snap = 0;
  if (!Number.isFinite(keyRoot) || keyRoot < 12 || keyRoot > 108) keyRoot = 45;
  if (!Number.isFinite(chordProg)) chordProg = 0;
  if (!Number.isFinite(ampFloor)) ampFloor = -55;
}

function analyse() {
  if (!micOK) return;
  const now = ac.currentTime;

  micFFT.analyze();
  fastAn.getFloatTimeDomainData(fastWave);
  fastAn.getFloatFrequencyData(fastFreq);
  slowAn.getFloatTimeDomainData(slowWave);
  slowAn.getFloatFrequencyData(slowFreq);

  let sum = 0, zc = 0;
  for (let i = 0; i < fastWave.length; i++) {
    sum += fastWave[i]*fastWave[i];
    if (i > 0 && (fastWave[i-1] < 0) !== (fastWave[i] < 0)) zc++;
  }
  F.rms = Math.sqrt(sum / fastWave.length);
  prevDb = F.db;
  F.db = 20 * Math.log10(Math.max(F.rms, 1e-7));
  F.zcr = zc * ac.sampleRate / fastWave.length / 2;
  F.jitter = constrain(map(F.zcr, 200, 5000, 0, 1), 0, 1);

  /* Duplex-gate: vores egen udgang omregnes til hvad den cirka
     larmer med i mikrofonen, og gaten hæves tilsvarende.        */
  outAn.getFloatTimeDomainData(waveOut);
  let os = 0;
  for (let i = 0; i < waveOut.length; i++) os += waveOut[i]*waveOut[i];
  const outDb = 20*Math.log10(Math.max(Math.sqrt(os/waveOut.length), 1e-7));

  /* Gulvet er det laveste, der er set i vinduet — altså rumtonen,
     per definition. Det kan hverken ratchette opad eller sætte sig
     fast, fordi det genberegnes fra rå målinger hver frame.      */
  if (!dbHist) { dbHist = new Float32Array(CFG.floorWin).fill(-60); }
  dbHist[dbPtr] = F.db;
  dbPtr = (dbPtr + 1) % dbHist.length;

  let roomMin = Infinity;
  for (let i = 0; i < dbHist.length; i++) if (dbHist[i] < roomMin) roomMin = dbHist[i];
  roomMin = constrain(roomMin, CFG.floorMin, CFG.floorMax);
  ampFloor += (roomMin - ampFloor) * CFG.floorTrack;
  ampFloor = constrain(ampFloor, CFG.floorMin, CFG.floorMax);

  /* Duplex-leddet får et loft. Uden det kan vores egen udgang
     skrue gaten så højt op, at ingen stemme kan nå den — og så
     står den lukket, mens motoren stille og roligt spiller sig
     selv i gang igen.                                            */
  /* Løber udgangen løbsk alligevel, skal den ikke kunne tage
     gaten med sig ned i graven. Er den pindet i mere end et halvt
     sekund, skrues masteren ned og der skrives til konsollen —
     så ved vi hvilket trin der er skyld i det.                  */
  if (outDb > -2) runaway++; else runaway = Math.max(0, runaway - 2);
  if (runaway > 30) {
    runawayTrim = Math.max(0.25, runawayTrim * 0.85);
    master.gain.setTargetAtTime(MIX.master * runawayTrim, now, 0.05);
    console.warn('[voice] udgangen loeb loebsk - master trimmet til ' +
                 nf(runawayTrim, 1, 2));
    runaway = 0;
  } else if (runawayTrim < 1 && outDb < -14) {
    runawayTrim = Math.min(1, runawayTrim + 0.004);
    master.gain.setTargetAtTime(MIX.master * runawayTrim, now, 0.4);
  }

  const spill = Math.min(outDb - CFG.spillOffset, ampFloor + CFG.spillCap);
  const gate = Math.max(ampFloor + CFG.gateDb, CFG.hardGate, spill);

  let lv = constrain((F.db - gate) / CFG.rangeDb, 0, 1);
  if (ampOpen) { if (lv < CFG.squelch * CFG.hysteresis) ampOpen = false; }
  else         { if (lv > CFG.squelch)                  ampOpen = true;  }
  F.level = ampOpen ? lv : 0;

  /* VAGTHUND. Uanset hvor omhyggeligt gaten er stillet ind, må den
     aldrig kunne stå lukket i det uendelige mens der faktisk kommer
     signal ind. Har der været tydeligt signal over den absolutte
     bund i tre sekunder uden at gaten er åbnet, er gulvet forkert,
     og det trækkes ned til det målte niveau.                     */
  if (!ampOpen && F.db > CFG.hardGate + 4) stuckFrames++;
  else stuckFrames = 0;

  if (stuckFrames > 180) {
    ampFloor = constrain(F.db - CFG.gateDb - 6, CFG.floorMin, CFG.floorMax);
    if (dbHist) dbHist.fill(ampFloor);
    stuckFrames = 0;
    console.warn('[voice] gaten sad fast — gulvet nulstillet til ' + ampFloor.toFixed(1) + ' dB');
  }
  F.smooth = lerp(F.smooth, F.level, F.level > F.smooth ? 0.44 : 0.38);

  const dt = deltaTime;
  if (F.level > 0) {
    F.silent = false; F.silenceMs = 0; F.sustainMs += dt;
    F.charge = min(1, F.charge + dt/2400 * (0.3 + F.level));
  } else {
    F.sustainMs = 0; F.silenceMs += dt;
    F.silent = F.silenceMs > 250;
    F.charge *= 0.9650;
  }

  const c = micFFT.getCentroid();
  if (isFinite(c) && c > 0) F.centroid = c;
  if (F.level > 0) F.bright = lerp(F.bright, constrain(
    Math.log(Math.max(F.centroid,120)/200) / Math.log(9000/200), 0, 1), 0.14);

  /* Flatness: geometrisk / aritmetisk middel af de LINEÆRE
     magnituder. FFT'ens byte-værdier er allerede dB-skalerede og
     duer ikke til forholdet.                                    */
  const binHz = ac.sampleRate / slowAn.fftSize;
  const lo = Math.floor(200/binHz), hi = Math.floor(8000/binHz);
  let logSum = 0, linSum = 0, n = 0;
  for (let i = lo; i < hi; i++) {
    const m = Math.pow(10, slowFreq[i]/20) + 1e-9;
    logSum += Math.log(m); linSum += m; n++;
  }
  // Er alle bins tomme, bliver exp(-Infinity)/0 til NaN. Kravet om
  // en positiv linSum er hele guarden.
  if (n > 0 && linSum > 1e-12) {
    const fl = Math.exp(logSum/n) / (linSum/n);
    if (Number.isFinite(fl)) {
      F.flatness = fl;
      F.noisiness = lerp(F.noisiness, constrain(
        map(Math.log10(fl + 1e-9), -3.2, -0.6, 0, 1), 0, 1), 0.12);
    }
  }

  /* Onset: dB-spring OG spektralt flux — niveauspring alene
     fanger også døre og bordbank.                               */
  const fb = fastAn.frequencyBinCount;
  if (!prevMag || prevMag.length !== fb) prevMag = new Float32Array(fb);
  let fl = 0, fsum = 0;
  for (let i = 2; i < fb; i++) {
    const m = Math.pow(10, fastFreq[i]/20);
    const d = m - prevMag[i];
    if (d > 0) fl += d;
    fsum += m; prevMag[i] = m;
  }
  F.flux = fl / (fsum + 1e-9);

  selfHits = selfHits.filter(t => now - t < 0.6);
  let blanked = false;
  for (const t of selfHits) if (now > t-0.02 && now < t + CFG.blankMs/1000) { blanked = true; break; }

  F.onset = 0;
  if (!blanked && F.level > 0 &&
      (F.db - prevDb) > CFG.transientDb && F.flux > CFG.fluxMin &&
      millis() - lastHitMs > CFG.hitGap) {
    lastHitMs = millis();
    F.onset = constrain((F.db - prevDb)/15, 0, 1);
    snap = 1;
    breakThrough(F.onset);

    /* Hvert anslag SPILLER en tone på både lead og bas. Velocity
       er anslagets styrke og styrer FM-index, filterets åbning og
       tonens længde — som på en rigtig synth, hvor et hårdere
       anslag giver en lysere og længere tone.

       Det er dét, der gør maskinen spillelig: dine konsonanter er
       anslagene, og den svarer med toner.                        */
    const vel = constrain(0.25 + F.onset*0.9, 0, 1);
    const nt = now + 0.012;
    if (leadAmp) leadNote(nt, snapToKey(freqToMidi(constrain(F.hz, 45, 700))) + CFG.octLead, vel);
    if (bassAmp) bassNote(nt, vel);
    if (pipExc)  pipStrike(nt, vel);
    selfHits.push(nt);
  }

  if (F.level > 0) {
    const p = detectPitch(slowWave, ac.sampleRate);
    F.f0 = p.f0; F.clarity = p.clarity;
    if (F.clarity > CFG.clarityMin && F.f0 > 0) {
      F.hz = lerp(F.hz, medianPitch(F.f0), 0.45);
      updateKey(freqToMidi(F.f0), dt);
    }
  } else { F.clarity = 0; keyHold = 0; pitchHist.length = 0; }

  if (anL && anR) {
    anL.getFloatTimeDomainData(waveL);
    anR.getFloatTimeDomainData(waveR);
    let sl = 0, sr = 0;
    for (let i = 0; i < waveL.length; i++) { sl += waveL[i]*waveL[i]; sr += waveR[i]*waveR[i]; }
    const rl = Math.sqrt(sl/waveL.length), rr = Math.sqrt(sr/waveR.length);
    // Mono ind i en splitter giver tavs højre kanal — det ville
    // blive aflæst som hårdt venstre. Derfor kræves begge kanaler.
    if (rl > 1e-5 && rr > 1e-5) stereoSeen = true;
    F.stereo = stereoSeen;
    F.pan = F.stereo && rl+rr > 1e-6
      ? lerp(F.pan, constrain((rr-rl)/(rr+rl), -1, 1), 0.15) : 0;
  }

  if (F.level > 0 && F.clarity > 0.35) detectVowel(binHz);

  sanitise();
}

function updateKey(midi, dt) {
  const cand = Math.round(midi) % 12;
  if (cand === keyCand % 12) keyHold += dt;
  else { keyCand = Math.round(midi); keyHold = 0; }
  /* Foer laa grundtonen ALTID i samme oktav: 33 + tonens klasse.
     Derfor blev bassen lige dyb, uanset om du sang hoejt eller
     lavt — den fulgte kun hvilken TONE du sang, ikke hvor.      */
  if (keyHold > 420) {
    keyRoot = constrain(Math.round(keyCand) - 12, 26, 54);
    keyHold = 0;
  }
}

function snapToKey(midi) {
  const sc = [0,2,3,5,7,8,10];
  let best = keyRoot, bd = 99;
  for (let oct = 0; oct <= 6; oct++)
    for (const s of sc) {
      const cand = keyRoot + s + oct*12;
      const d = Math.abs(cand - midi);
      if (d < bd) { bd = d; best = cand; }
    }
  return best;
}

function detectVowel(binHz) {
  const span = F.f0 > 60 ? Math.max(3, Math.round(F.f0/binHz*0.75)) : 7;
  const peak = (loHz, hiHz) => {
    const a = Math.floor(loHz/binHz), b = Math.floor(hiHz/binHz);
    let best = -Infinity, bi = a;
    for (let i = a; i < b; i++) {
      let s = 0, cnt = 0;
      for (let j = -span; j <= span; j++) {
        const k = i+j;
        if (k >= 0 && k < slowFreq.length) { s += slowFreq[k]; cnt++; }
      }
      if (s/cnt > best) { best = s/cnt; bi = i; }
    }
    return bi * binHz;
  };
  F.f1 = lerp(F.f1 || 500, peak(250, 1000), 0.18);
  F.f2 = lerp(F.f2 || 1200, peak(800, 2900), 0.18);

  let bi = presetIdx, bd = Infinity;
  for (let i = 0; i < VOWELS.length; i++) {
    const v = VOWELS[i];
    // Afstand i log-frekvens — øret hører oktaver, ikke hertz
    const d = Math.pow(Math.log(F.f1/v.f1),2) + Math.pow(Math.log(F.f2/v.f2),2);
    if (d < bd) { bd = d; bi = i; }
  }
  F.vowel = VOWELS[bi].id;
  if (bi !== presetIdx && F.charge > 0.3) { presetIdx = bi; preset = VOWELS[bi]; }
}

/* TONEHØJDE MED YIN
   Ren autokorrelation finder den lag, hvor signalet ligner sig
   selv MEST — og det dobbelte lag ligner altid næsten lige så
   godt, hvilket er grunden til at den så ofte rammer en oktav
   for lavt. YIN vender problemet om og leder efter den lag, hvor
   signalet ligner sig selv MINDST DÅRLIGT:

     1) differensfunktionen d(t) = sum (x[i] - x[i+t])^2
     2) den kumulative middelnormalisering d'(t), som gør små
        lag dyrere og dermed fjerner oktavfejlen ved roden
     3) første t under en absolut tærskel — ikke det globale
        minimum, for det er netop dér oktavfejlen bor
     4) parabolsk interpolation for opløsning under ét sample

   Klarheden falder direkte ud som 1 - d'(t) og er langt mere
   ærlig end autokorrelationens toppunkt.                        */
function detectPitch(buf, sr) {
  const n = (buf.length/4)|0;
  if (!dec || dec.length !== n) {
    dec = new Float32Array(n);
    yin = new Float32Array(n + 2);
  }
  // 4-taps middel: groft lavpas plus firdobbelt hastighed
  for (let i = 0; i < n; i++) {
    const j = i*4;
    dec[i] = (buf[j] + buf[j+1] + buf[j+2] + buf[j+3]) * 0.25;
  }
  const sr2 = sr/4;
  const tMin = Math.max(2, Math.floor(sr2/CFG.voiceHigh));
  const tMax = Math.min(n - 2, Math.ceil(sr2/CFG.voiceLow));
  if (tMax <= tMin + 2) return { f0: 0, clarity: 0 };

  // 1) differensfunktion
  for (let t = tMin; t <= tMax; t++) {
    let sum = 0;
    const lim = n - t;
    for (let i = 0; i < lim; i++) { const d = dec[i] - dec[i+t]; sum += d*d; }
    yin[t] = sum;
  }

  // 2) kumulativ middelnormalisering
  let run = 0;
  for (let t = tMin; t <= tMax; t++) {
    run += yin[t];
    yin[t] = run > 1e-12 ? yin[t] * (t - tMin + 1) / run : 1;
  }

  // 3) første dal under tærsklen, ikke det globale minimum
  let best = -1;
  for (let t = tMin; t <= tMax; t++) {
    if (yin[t] < CFG.yinThresh) {
      let k = t;
      while (k + 1 <= tMax && yin[k+1] < yin[k]) k++;   // ned i dalens bund
      best = k; break;
    }
  }
  if (best < 0) {
    let mn = Infinity;
    for (let t = tMin; t <= tMax; t++) if (yin[t] < mn) { mn = yin[t]; best = t; }
    if (best < 0 || mn > 0.55) return { f0: 0, clarity: 0 };
  }

  // 4) parabolsk interpolation
  let tau = best;
  if (best > tMin && best < tMax) {
    const y0 = yin[best-1], y1 = yin[best], y2 = yin[best+1];
    const den = 2*(2*y1 - y0 - y2);
    if (Math.abs(den) > 1e-9) tau += constrain((y2 - y0)/den, -1, 1);
  }

  return { f0: sr2/tau, clarity: constrain(1 - yin[best], 0, 1) };
}

/* Median over de seneste fem målinger. En enkelt fejlmåling —
   og der kommer altid nogle — bliver sorteret væk i stedet for
   at trække tonen med sig. Median frem for middel, netop fordi
   en oktavfejl er stor og sjælden.                              */
function medianPitch(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return F.hz;
  pitchHist.push(hz);
  if (pitchHist.length > 5) pitchHist.shift();
  const a = pitchHist.slice().sort((x, y) => x - y);
  return a[floor(a.length/2)];
}

/* ---------- 6. STEMMERNE ----------------------------------- */

function notchVal(src) {
  switch (src) {
    case 'level':     return F.smooth;
    case 'bright':    return F.bright;
    case 'pitch':     return constrain(map(F.hz, 70, 500, 0, 1), 0, 1);
    case 'noisiness': return F.noisiness;
    case 'charge':    return F.charge;
    case 'jitter':    return F.jitter;
    case 'f1':        return constrain(map(F.f1, 250, 1000, 0, 1), 0, 1);
    case 'f2':        return constrain(map(F.f2, 800, 2900, 0, 1), 0, 1);
  }
  return 0.5;
}

function updateVoices() {
  if (!micOK) return;
  const now = ac.currentTime;

  /* Nærvær: hurtigt op, og hurtigt nok ned til at du kan HØRE at
     det er dig der styrer. Under ét sekunds hale — nok til at det
     ikke klikker, ikke nok til at det kører videre af sig selv. */
  const target = F.level > 0 ? Math.pow(F.smooth, 0.85)
               : (F.silenceMs < CFG.tailMs ? presence * CFG.tailDecay : 0);
  presence += (target - presence) * (target > presence ? 0.16 : CFG.fallRate / MIX.release);
  if (presence < 0.002) presence = 0;

  const P = presence;
  const freeHz = constrain(F.clarity > 0.4 ? F.hz : midiToFreq(keyRoot+12), 45, 700);
  const leadMidi = snapToKey(freqToMidi(freeHz)) + 12;
  const lhz = midiToFreq(leadMidi);

  /* VOKALEN vælger akkorden. A, E, I, O og U har hver sin, så du
     kan synge dig gennem harmonikken — det er den mest direkte
     kobling mellem mund og musik i hele patchen.

     Varigheden lægger sig ovenpå som en omvending: holder du en
     tone længe nok, flytter stemmerne sig et trin op i akkorden
     uden at akkorden i sig selv skifter.                        */
  /* VOKALEN vælger tonen. A, E, I, O og U har hver sit skalatrin,
     så du kan synge dig gennem melodien. Varigheden lægger sig
     ovenpå som et oktavløft: holder du længe nok, flytter de
     nederste stemmer sig en oktav op.                           */
  /* Sangtonen kommer nu fra DIN TONE, ikke fra vokalen. Foer laa
     kor, shimmer og vocoderens baerebolge alle paa en tone som
     vokalen valgte — derfor kunne man synge en melodi uden at
     noget som helst fulgte med. Vokalen vaelger nu kun hvilket
     interval der laegges ovenpaa.                                */
  chordIdx = presetIdx % VOWEL_NOTE.length;
  chordProg += (deltaTime/1000) * (F.sustainMs > 250 ? (0.25 + F.smooth*1.1) : -0.9);
  chordProg = constrain(chordProg, 0, 9);
  const lift = floor(chordProg / 4.5) * 12;

  const sungMidi = snapToKey(freqToMidi(freeHz));
  musLead = sungMidi;
  const songNote = F.clarity > 0.35
    ? sungMidi - 12 + (VOWEL_NOTE[chordIdx] > 6 ? 0 : VOWEL_NOTE[chordIdx])
    : keyRoot + VOWEL_NOTE[chordIdx];

  /* Hvert lag har sin egen primære deskriptor OG sin egen
     hastighed. Fulgte de alle lydstyrken, ville de bevæge sig som
     én blok; her skifter de forskelligt, men de er alle gatet af
     nærværet, så helheden hænger sammen.

       DYB     lydstyrke, øjeblikkeligt
       SUB     tonehøjde, roligt
       DRONE   tonehøjde + lydstyrke + klangfarve, PERFEKT sporing
       LUFT    fladhed alene
       KOR     varighed, langsomt
       LEAD    klangfarve gange lydstyrke
       SHIMMER varighed gange klangfarve, langsomst              */
  // Kvadreret: lagene kommer ind sent og hårdt frem for at snige
  // sig ind — abrupte indsatser er halvdelen af udtrykket.
  const stage = (t) => Math.pow(constrain((P - t) / max(0.05, 0.95 - t), 0, 1), 1.6);

  /* --- SUB -------------------------------------------------- */
  subGain.gain.setTargetAtTime(
    Math.pow(stage(CFG.inSub), 1.1) * MIX.sub * (0.4 + F.clarity*0.8), now, 0.035);

  /* Bas og sub glider MED stemmen, ikke kun ved anslag. Uden det
     staar bunden stille mens alt andet bevaeger sig, og saa foeles
     det ikke som om tonehoejden styrer.                          */
  const bMidi = bassNoteFor(freqToMidi(constrain(F.hz, 40, 900)) - 12);
  musBass = bMidi; musVowel = presetIdx;
  const bHz = midiToFreq(bMidi);
  for (const b of bassOscs) b.osc.frequency.setTargetAtTime(bHz, now, 0.055);
  bassCorpus.frequency.setTargetAtTime(bHz * 2, now, 0.07);
  subOsc.frequency.setTargetAtTime(midiToFreq(constrain(bMidi - 12, 18, 46)), now, 0.09);

  /* --- BAS: krop, filter og duck ---------------------------
     Anslagene spiller tonerne; her styres kun det holdte.       */
  bassBody.gain.setTargetAtTime(Math.pow(F.smooth, 1.2) * MIX.deep, now, 0.012);
  bassLP.frequency.setTargetAtTime(200 + F.bright*520 + F.charge*180, now, 0.06);
  bassLP.Q.setTargetAtTime(3 + F.charge*3, now, 0.20);
  deepGain.gain.setTargetAtTime(1, now, 0.10);
  updateBank(bassBank, now, 1.5 + F.smooth*1.2, 2.0 + F.smooth*2);

  /* --- PIP: hoej resonans der foelger tonen ----------------- */
  freeHzHUD = freeHz;
  for (const p of pipBP) {
    p.bp.frequency.setTargetAtTime(
      constrain(freeHz * p.ratio, 700, 7500), now, 0.03);
    p.bp.Q.setTargetAtTime(28 + F.charge*34 + F.jitter*14, now, 0.25);
  }
  // Svag konstant tilfoersel mens du taler, saa den ringer med
  pipGain.gain.setTargetAtTime(
    Math.pow(F.smooth, 1.4) * (0.075 + F.bright*0.060), now, 0.030);

  /* --- DRONE: den perfekte oversættelse ---------------------
     Dette lag har med vilje næsten ingen udglatning. Tonehøjden
     følger din grundtone ukvantiseret med 8 ms, niveauet med 20,
     og filteret klangfarven med 25. Alt hvad du gør med stemmen —
     glidninger, vibrato, en stavelse der falder — kommer direkte
     ud. Det er dét lag der får det til at føles som oversættelse
     frem for ledsagelse.                                        */
  drOsc.frequency.setTargetAtTime(freeHz * 0.5, now, 0.008);   // en oktav under din
  drFilt.frequency.setTargetAtTime(200 + F.bright*2300 + snap*900, now, 0.020);

  // Formanterne sporer direkte. Dybden følger klarheden: er tonen
  // tonal, træder vokalen tydeligt frem; er den støjet, flader
  // toppene ud, præcis som en hvisket vokal gør i virkeligheden.
  drF1.frequency.setTargetAtTime(constrain(F.f1 || 600, 200, 1200), now, 0.03);
  drF2.frequency.setTargetAtTime(constrain(F.f2 || 1400, 700, 3000), now, 0.03);
  drF1.gain.setTargetAtTime(4 + F.clarity*9, now, 0.06);
  drF2.gain.setTargetAtTime(3 + F.clarity*7, now, 0.06);
  drF1.Q.setTargetAtTime(3 + F.jitter*4, now, 0.1);
  drFilt.Q.setTargetAtTime(preset.q * (0.6 + F.charge*0.6), now, 0.15);
  drTone.gain.setTargetAtTime(1 - F.noisiness*0.35, now, 0.05);
  drNz.gain.setTargetAtTime(F.noisiness*0.16, now, 0.06);
  const dd = preset.drive * (0.78 + P*0.60) * MIX.drive;
  if (Math.abs(dd - drDrive) > 0.3) { drDrive = dd; drSat.curve = tubeCurve(dd); }
  drPan.pan.setTargetAtTime(constrain(-0.12 + F.pan*0.45, -1, 1), now, 0.05);
  drGain.gain.setTargetAtTime(Math.pow(F.smooth, 1.25) * MIX.drone, now, 0.006);

  /* --- KORET: uafhængige cyklusser --------------------------
     Hver stemme har sin egen periode. Kurven er hævet i en potens,
     så stemmen er tavs det meste af sin cyklus og kun toner frem
     et stykke ad gangen — ellers ville alle seks ligge og lyde
     hele tiden, og så var vi tilbage ved mudderet.              */
  /* Fasen skrider kun frem mens DU laver lyd. Kørte cyklusserne
     på væguret, bevægede koret sig videre af sig selv — og det er
     præcis dét, der føles som at det flyder frem for at følge.   */
  const step = (deltaTime/1000) * (0.12 + P*1.9);
  for (let i = 0; i < choir.length; i++) {
    const v = choir[i];
    v.ph = (v.ph + step / v.period) % 1;
    // Hvert anslag nykker korstemmerne frem. Kortere cyklusser
    // nykkes mest, så en konsonant river teksturen i stykker
    // oppefra i stedet for at flytte alt lige meget.
    if (F.onset > 0) v.ph = (v.ph + F.onset * 0.05 * (6 - i) / 6) % 1;
    const env = Math.pow(0.5 - 0.5*Math.cos(v.ph * TWO_PI), 2.2);
    const midi = songNote + CFG.octChoir + CHOIR_OCT[i] + (i < 3 ? lift : 0);
    v.osc.frequency.setTargetAtTime(midiToFreq(midi), now, 0.4);
    v.gain.gain.setTargetAtTime(env * 0.22, now, 0.035);
    // Stereobilledet åbner og lukker med din egen L/R-balance
    v.pan.pan.setTargetAtTime(
      constrain([-0.7,0.5,-0.3,0.75,0.1,-0.55][i] * (0.35 + Math.abs(F.pan)*0.9 + F.jitter*0.3)
                + F.pan*0.25, -1, 1), now, 0.25);
  }
  choirFilt.frequency.setTargetAtTime(500 + F.bright*1800 + F.charge*1400, now, 0.2);
  choirGain.gain.setTargetAtTime(
    Math.pow(F.charge, 0.75) * (0.30 + P*0.70) * MIX.choir, now, 0.045);

  /* --- AIR -------------------------------------------------- */
  if (airGain) {
    airFilt.frequency.setTargetAtTime(700 + F.bright*5200, now, 0.3);
    airFilt.Q.setTargetAtTime(0.5 + F.jitter*2, now, 0.4);
    // Luften er nu ALENE styret af fladhed, med en dødzone under
    // 0,40 — hvisker du ikke, findes laget ikke.
    const hiss = constrain((F.noisiness - 0.40) / 0.60, 0, 1);
    airGain.gain.setTargetAtTime(stage(CFG.inAir) * hiss * MIX.air, now, 0.028);
  }

  /* --- LEAD -------------------------------------------------
     Anslagene spiller tonerne; her styres kun det holdte. De to
     gain-trin ligger i serie — envelopen på leadAmp, kroppen på
     leadBody — så envelopen aldrig slås med den løbende styring
     om den samme parameter.                                     */
  const raw = stage(CFG.inLead) * constrain((F.bright - 0.30) / 0.50, 0, 1);
  leadAmt = lerp(leadAmt, raw, raw > leadAmt ? 0.22 : 0.20);

  /* Leadets grundtone glider med din stemme hele tiden — ikke kun
     naar en tone udloeses. Synger du et glissando, boejer den med. */
  const lockAmt = constrain((F.clarity - 0.35) / 0.45, 0, 1);
  const leadMidiNow = lerp(freqToMidi(freeHz), snapToKey(freqToMidi(freeHz)), lockAmt);
  leadOsc.frequency.setTargetAtTime(
    midiToFreq(constrain(leadMidiNow + CFG.octLead, 30, 108)), now, 0.030);
  leadFM.frequency.setTargetAtTime(
    midiToFreq(constrain(leadMidiNow + CFG.octLead, 30, 108)) *
    (1 + (F.bright > 0.5 ? 1 : 0)), now, 0.040);

  leadBody.gain.setTargetAtTime(0.25 + Math.pow(F.smooth, 1.1) * 0.75, now, 0.014);
  leadFilt.Q.setTargetAtTime(11 + leadAmt*9 + F.charge*5, now, 0.15);

  // COMB-resonansen mellem 94 og 97 procent. Over ca. 0,98 svinger
  // sløjfen selv og bliver til en tone der aldrig dør.
  // Loft ved 0,93. Sløjfen er selvbegrænsende, men høj resonans
  // plus LFO'ens udsving skal stadig ikke kunne nå 1,0.
  combFb.gain.setTargetAtTime(0.860 + F.charge*0.055, now, 0.40);
  combMix.gain.setTargetAtTime(0.40 + F.bright*0.35, now, 0.25);

  leadPan.pan.setTargetAtTime(constrain(0.18 - F.pan*0.45, -1, 1), now, 0.12);
  leadGain.gain.setTargetAtTime(Math.pow(leadAmt, 1.15) * MIX.lead, now, 0.030);

  // To modulationer: én langsom, én meget langsommere, med
  // uafrundede rater så de aldrig mødes to gange
  leadLfoA.frequency.setTargetAtTime(0.05 + F.jitter*0.25, now, 1.0);
  leadLfoB.frequency.setTargetAtTime(0.011 + F.charge*0.017, now, 2.0);

  flange.lfo.frequency.setTargetAtTime(0.06 + F.jitter*0.30 + leadAmt*0.26, now, 0.6);
  flange.depth.gain.setTargetAtTime(0.0034 * (0.55 + F.smooth*0.40), now, 0.25);
  flange.fb.gain.setTargetAtTime(0.46 + F.charge*0.16 + leadAmt*0.08, now, 0.5);
  flange.wet.gain.setTargetAtTime(0.80 + leadAmt*0.20, now, 0.4);
  flange2.lfo.frequency.setTargetAtTime(
    (0.06 + F.jitter*0.30) * 2.7 + F.bright*0.35, now, 0.6);
  flange2.depth.gain.setTargetAtTime(0.0019 * (0.5 + leadAmt*0.5), now, 0.25);
  flange2.fb.gain.setTargetAtTime(0.40 + F.bright*0.18, now, 0.5);

  /* --- SHIMMER ---------------------------------------------- */
  for (let i = 0; i < shimOscs.length; i++) {
    shimOscs[i].frequency.setTargetAtTime(
      midiToFreq(songNote + CFG.octShim + (i === 2 ? 7 : 0)), now, 0.8);
  }
  shimGain.gain.setTargetAtTime(F.charge * F.bright * stage(CFG.inShim) * 0.11, now, 0.15);

  /* --- Notches (parallel) og master ------------------------- */

  /* --- STEMMELAGET ------------------------------------------
     Gaten på voiceIn er både musik og sikkerhed: er der ingen
     stemme, er der ingen vej fra mikrofon til højttaler, og så
     kan sløjfen ikke lukke sig. Angreb hurtigt, slip hurtigt.  */
  voiceIn.gain.setTargetAtTime(F.level > 0 ? 1 : 0, now, F.level > 0 ? 0.010 : 0.040);

  // Bærebølgen sidder på SANGTONEN, ikke på din — det er dét, der
  // gør stemmen musikalsk i stedet for bare forvrænget
  /* Baerebolgen foelger din grundtone direkte. Synger du en
     melodi, synger vocoderen den samme — det er den enkeltaendring
     der goer mest for fornemmelsen af at tonehoejden styrer.     */
  const carMidi = lerp(freqToMidi(constrain(F.hz, 55, 900)), sungMidi,
                       constrain((F.clarity - 0.3) / 0.5, 0, 1));
  vocCar.frequency.setTargetAtTime(
    midiToFreq(constrain(carMidi - 12 + (F.bright > 0.62 ? 12 : 0), 24, 96)), now, 0.025);

  /* FORMANTERNE MODULERER. Bærebølgens bånd sidder ikke længere
     fast på analysebåndenes frekvenser — hvert bånd har sin egen
     langsomme LFO og sin egen retning, oven på en fælles forskyd-
     ning der følger klangfarven.

     At flytte bærebåndene VÆK fra analysebåndene er hele pointen:
     så bliver båndet der åbnes ikke det samme som båndet der blev
     målt, og stemmen kommer ud med en anden mund end den gik ind
     med. Står de præcist over for hinanden, er en vocoder bare et
     filter der følger med.

     Dybden reguleres omvendt af niveauet, så mønsteret bevares:
     uden det ville alle bånd stå på vid gab ved høj stemme, og så
     er der ingen vocoder tilbage — kun en brummende sav.        */
  const shift = 0.80 + F.bright*0.55 + F.charge*0.18;
  const modAmt = (0.10 + F.jitter*0.28 + F.noisiness*0.20 + snap*0.15) * MIX.fmod;

  for (let i = 0; i < vocBands.length; i++) {
    const b = vocBands[i];
    const wob = Math.sin(now*TWO_PI*(0.07 + i*0.031) + i*1.9) * modAmt
              * (i % 2 ? 1 : -1);
    b.bc.frequency.setTargetAtTime(
      constrain(b.f * shift * (1 + wob), 60, 12000), now, 0.05);
    b.bc.Q.setTargetAtTime(b.q * (0.7 + F.charge*0.8), now, 0.12);

    /* Nævneren kan blive lille ved lav stemme, og uden loft blev
       forstærkningen ind i VCA'ens gain-parameter tredive gange
       for stor. Det pinder limiteren lige så effektivt som en
       ustabil sløjfe.                                            */
    const dep = CFG.vocDepth * (0.55 + F.noisiness*0.5) / (0.45 + F.smooth*0.9);
    b.depth.gain.setTargetAtTime(Math.min(dep, 22), now, 0.05);
  }

  vocGain.gain.setTargetAtTime(Math.pow(F.smooth, 1.0) * MIX.voc, now, 0.010);
  // Den tørre stemme er slået fra: rå mikrofon i mixet trækker
  // altid mod podcast. Alt hvad du hører af stemme, går gennem
  // vocoderen.
  voiceGain.gain.setTargetAtTime(0, now, 0.05);

  if (CFG.duck > 0) {
    bedBus.gain.setTargetAtTime(1 - CFG.duck * Math.pow(F.smooth, 0.8), now, 0.03);
  }
  updateBank(voiceBank, now, 1.7 + F.smooth*2.0, 2.4 + F.jitter*3);

  /* Bankerne fejer efter stemmen. Spændet vokser med lydstyrken,
     så de står næsten stille når du er stille og river hen over
     hele elementets område når du går på.                       */
  const sweep = (1.6 + F.smooth*2.4 + snap*1.2) * MIX.sweep;
  updateBank(drBank,    now, sweep,              2.4 + F.charge*3);
  updateBank(choirBank, now, 1.5 + F.charge*2.2, 2.0 + F.jitter*2);
  // Morpheus-tanken: leadets bank fejer MEGET langsommere end de
  // andre. Det er den langsomme, uafhængige bevægelse der giver
  // fornemmelsen af noget levende frem for en modulation.
  updateBank(leadBank,  now, 2.0 + F.charge*1.6,  2.6 + leadAmt*4);
  if (airBank) updateBank(airBank, now, 1.8 + F.noisiness*2.4, 2.2);
  updateBank(vocBank, now, 1.7 + F.smooth*2.2 + F.jitter*1.4, 2.6 + F.charge*3);

  revWet.gain.setTargetAtTime((0.05 + F.charge*0.11) * MIX.verb, now, 0.12);
  bellEq.gain.setTargetAtTime(
    CFG.bellDb + CFG.bellExtra * constrain((F.bright-0.55)/0.45, 0, 1), now, 0.8);
}

/* ---------- 7. BUFFERE OG KURVER --------------------------- */

function makeNoise(sec) {
  const b = ac.createBuffer(1, ac.sampleRate*sec, ac.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random()*2-1;
  return b;
}

function makeImpulse(sec, decay) {
  const len = Math.floor(ac.sampleRate*sec);
  const b = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random()*2-1)*Math.pow(1 - i/len, decay);
  }
  return b;
}

/* Asymmetrisk mætning. Forskydningen før tanh gør kurven skæv, og
   skæve kurver laver LIGE overtoner. Det er forskellen på tykt og
   fizzy: symmetrisk klipning giver kun ulige overtoner, som lyder
   hult og hårdt. Konstanten trækkes fra igen, så der ikke bliver
   DC tilbage.                                                   */
function tubeCurve(k, bias = 0.20, n = 2048) {
  const c = new Float32Array(n);
  const off = Math.tanh(k*bias);
  const peak = Math.max(
    Math.abs(Math.tanh(k*( 1+bias)) - off),
    Math.abs(Math.tanh(k*(-1+bias)) - off));
  for (let i = 0; i < n; i++) {
    const x = (i/(n-1))*2 - 1;
    c[i] = (Math.tanh(k*(x+bias)) - off) / peak;
  }
  return c;
}

/* ---------- 8. VISUELT: PUNKTSKY, LINJER, BLOOM -----------
   Ingen flader. Formen bygges af nogle tusinde lysende punkter og
   en tynd, sammenhaengende linje — oscilloskop frem for objekt.

   BLOOM'EN er det, der giver skaerm-udtrykket, og den er billig:
   scenen tegnes til en buffer, som skaleres NED to gange. En
   nedskalering med udjaevning ER en slooring, saa der skal ingen
   filterkerne til. De to smaa buffere skaleres op igen og laegges
   additivt oveni. Det er derfor lyse pixels bloeder ud i moerket,
   mens sorte flader forbliver rene.

   Der er kun hvidt og én accent. Accenten bruges udelukkende til
   svaret og til anslag — bruges den ogsaa til alt det andet, er
   det ikke laengere en accent.                                   */

const VIS = {
  points: 2400,
  fov: 1.9,
  accent: '90,150,255' // neonblaa
};

let scene = null, sctx = null, b1 = null, b2 = null;
let cloud = [], vt = 0, yaw = 0, pit = 0;
let reply = 0, onsetPulse = 0, freeHzHUD = 110;
let utt = { rec: [], playAt: 0, playing: false, idx: 0 };
let musBass = 33, musLead = 45, musVowel = 2;
let vFast = 0;
let vLevel = 0, vBright = 0.4, vPitch = 0.3, vNoisy = 0.3,
    vClarity = 0, vCharge = 0, vPan = 0, vF1 = 0.4, vF2 = 0.4;

function makeBuffers() {
  scene = document.createElement('canvas');
  scene.width = width; scene.height = height;
  sctx = scene.getContext('2d');

  const mk = (d) => {
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.floor(width/d));
    c.height = Math.max(2, Math.floor(height/d));
    c.getContext('2d').imageSmoothingEnabled = true;
    return c;
  };
  b1 = mk(4); b2 = mk(12);
}

function frameOf() {
  return { lvl: presence, bright: F.bright, hz: F.hz, noisy: F.noisiness };
}

function recordUtterance() {
  if (F.level > 0) {
    if (utt.playing) utt.playing = false;
    if (frameCount % 2 === 0 && utt.rec.length < 240) utt.rec.push(frameOf());
    utt.playAt = 0;
  } else if (utt.rec.length > 10 && !utt.playing && utt.playAt === 0) {
    utt.playAt = millis() + 260;
  }
  if (utt.playAt && !utt.playing && millis() > utt.playAt) {
    utt.playing = true; utt.idx = 0; utt.playAt = 0;
  }
}

function playReply() {
  if (!utt.playing) return null;
  const f = utt.rec[utt.idx];
  utt.idx++;
  if (utt.idx >= utt.rec.length) { utt.playing = false; utt.rec = []; }
  return f || null;
}

function breakThrough(force) {
  // Diskret: anslaget maerkes i kroppen, det ses ikke som et spring
  onsetPulse = min(0.6, onsetPulse + 0.14 + force*0.20);
  periAt = millis();
}

function drawField() {
  if (!started) {
    background(0);
    noStroke(); fill(150, 165, 190, 150);
    textAlign(CENTER, CENTER); textSize(18);
    text('Click to enable microphone (wear a headset unless you want to unleash chaos)', width/2, height/2);
    return;
  }
  if (!scene || scene.width !== width) { makeBuffers(); if (!cloud.length) makeSprites(); }

  recordUtterance();
  const rf = playReply();
  reply = lerp(reply, rf ? rf.lvl : 0, 0.10);
  onsetPulse *= 0.968;

  const lvl = rf ? max(presence, rf.lvl*0.85) : presence;
  /* To udglatninger af samme signal: en hurtig til kroppen og en
     traeg til feltet. Kroppen skal svare med det samme; stroemmen
     skal ikke ryste med hver stavelse.                           */
  vLevel   = lerp(vLevel,   lvl, 0.055);
  vFast    = lerp(vFast,    lvl, lvl > vFast ? 0.16 : 0.075);
  vBright  = lerp(vBright,  F.bright, 0.028);
  vPitch   = lerp(vPitch,   constrain(map(F.hz, 70, 460, 0, 1), 0, 1), 0.035);
  vNoisy   = lerp(vNoisy,   F.noisiness, 0.025);
  vClarity = lerp(vClarity, F.clarity, 0.025);
  vCharge  = lerp(vCharge,  F.charge, 0.018);
  vPan     = lerp(vPan,     F.pan, 0.022);
  vF1      = lerp(vF1, constrain(map(F.f1, 260, 950, 0, 1), 0, 1), 0.020);
  vF2      = lerp(vF2, constrain(map(F.f2, 700, 2600, 0, 1), 0, 1), 0.020);

  const alive = constrain((vLevel + reply*0.8) / 0.06, 0, 1);
  // Udsendelsen foelger det RAA niveau, ikke det udglattede — saa
  // stopper foedslerne i samme oejeblik du holder op
  const emit = max(F.level, reply * 0.9);

  vt  += 0.00050 + vLevel*0.0011;
  yaw += 0.00032 + vLevel*0.00070 - reply*0.00050;
  pit  = Math.sin(vt*0.5) * 0.26 + vPan*0.20;

  /* Efterlysning frem for sletning: linjen efterlader et svagt
     spor, praecis som fosforen paa et oscilloskop.               */
  sctx.globalCompositeOperation = 'source-over';
  sctx.globalAlpha = 1;
  sctx.fillStyle = 'rgba(0,0,0,' + (emit > 0.02 ? 0.085 : 0.26).toFixed(3) + ')';
  sctx.fillRect(0, 0, width, height);

  /* Tegnes ogsaa mens alive falder mod nul: de sidste punkter skal
     have lov at leve deres levetid faerdig og forsvinde af sig
     selv. Klippes de af, laeses det som en afbrydelse.           */
  const vis = max(alive, emit > 0.02 ? 1 : 0);
  if (vis > 0.002 || livePts > 0) {
    sctx.globalCompositeOperation = 'lighter';
    drawCloud(sctx, max(alive, 0.0), emit);
  }

  // --- BLOOM: to nedskaleringer, ingen filterkerne noedvendig
  const c1 = b1.getContext('2d'), c2 = b2.getContext('2d');
  c1.globalCompositeOperation = 'copy';
  c1.drawImage(scene, 0, 0, b1.width, b1.height);
  c2.globalCompositeOperation = 'copy';
  c2.drawImage(b1, 0, 0, b2.width, b2.height);

  const ctx = drawingContext;
  ctx.globalCompositeOperation = 'copy';
  ctx.globalAlpha = 1;
  ctx.drawImage(scene, 0, 0, width, height);

  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.38 + vLevel*0.16;
  ctx.drawImage(b1, 0, 0, width, height);
  ctx.globalAlpha = 0.46 + vLevel*0.18 + onsetPulse*0.10;
  ctx.drawImage(b2, 0, 0, width, height);

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// Projektion. Rotation om to akser, derefter perspektivdeling.
function proj(x, y, z) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  let X = x*cy - z*sy, Z = x*sy + z*cy;
  const cp = Math.cos(pit), sp = Math.sin(pit);
  let Y = y*cp - Z*sp; Z = y*sp + Z*cp;
  const s = VIS.fov / (Z + 3.4);
  return { x: width*0.5 + X*s*height*0.5 + vPan*width*0.05,
           y: height*0.5 + Y*s*height*0.5, s: s };
}

/* ÉT LEGEME.
   Partiklerne og figuren var to ting foer. Nu er de det samme:
   hver partikel har en plads U paa kurven, og kurven tegnes
   udelukkende gennem dem. Der er ingen streg mere — formen ER
   skyen, og skyen ER formen.

   Partiklerne kryber langsomt langs kurven og driver samtidig lidt
   VAEK fra den, holdt tilbage af en fjeder. Klarheden bestemmer
   fjederens styrke: en ren tone samler dem til én tynd fiber, en
   aandet lader dem sprede sig til en taage. Det er dér efter-
   ligningen ligger — kroppen strammer og slipper med stemmen.   */

let ra = 2, rb = 3, rc = 4;
const _f = { x: 0, y: 0, z: 0 };

function field(p, out) {
  const sc = 0.9 + vPitch*1.8;
  const t = vt * (0.4 + vLevel*0.5);
  const ax = p.x*sc, ay = p.y*sc, az = p.z*sc;
  out.x = Math.sin(ay*1.7 + t) - Math.cos(az*1.3 - t*0.7);
  out.y = Math.sin(az*1.9 + t*1.1) - Math.cos(ax*1.5 + t*0.5);
  out.z = Math.sin(ax*1.6 - t*0.9) - Math.cos(ay*1.4 + t*1.3);
}

// Kroppens kurve. Forholdene glider, saa figuren morfer i stedet
// for at hoppe naar musikken skifter tone.
function bodyAt(u, o) {
  o.x = Math.sin(ra*u + vt*0.55) * ax_ * rad;
  o.y = Math.sin(rb*u + vt*0.40 + 1.1) * ay_ * rad * 0.92;
  o.z = Math.sin(rc*u + vt*0.28 + 2.3) * az_ * rad;
}

let ax_ = 1, ay_ = 1, az_ = 1;
const _b = { x: 0, y: 0, z: 0 };

function respawn(p) {
  p.u = Math.random() * TWO_PI;
  p.ox = p.oy = p.oz = 0;
  p.vx = p.vy = p.vz = 0;
  p.px = null;
  p.life = 0;
  p.span = 0.0011 + Math.random()*0.0030;   // lange levetider = roligt
}

function makeSprites() {
  cloud = [];
  for (let i = 0; i < VIS.points; i++) {
    const p = {};
    respawn(p);
    p.life = Math.random();
    cloud.push(p);
  }
}

let livePts = 0;
let rad = 0.55, radV = 0, peri = -9, periAt = 0;

/* AANDEDRAETTET. En fjeder frem for en udglatning, men blødt
   stemt: lav stivhed og høj daempning, saa den vugger paa plads i
   stedet for at slaa. Anslagets bidrag er lille — det skal kunne
   MAERKES, ikke ses som et spring.                              */
function breath() {
  const target = 0.46 + vFast*0.20 + vCharge*0.08 - onsetPulse*0.07;
  radV += (target - rad) * 0.028;
  radV *= 0.905;
  rad += radV;
  rad = constrain(rad, 0.22, 0.95);

  ax_ = lerp(ax_, 1 + (vF2 - 0.5)*0.34, 0.02);
  ay_ = lerp(ay_, 1 + (vF1 - 0.5)*0.34 + (vPitch - 0.5)*0.22, 0.02);
  az_ = lerp(az_, 1 - (vF1 + vF2 - 1.0)*0.14, 0.02);

  // Forholdene fra de toner der spiller, glidende
  const iv = constrain(musLead - musBass, 0, 36);
  ra = lerp(ra, 2 + iv/12, 0.006);
  rb = lerp(rb, 3 + musVowel*0.8, 0.006);
  rc = lerp(rc, 4 + (iv % 12)/5, 0.006);
}

function drawCloud(ctx, alive, emit) {
  livePts = 0;
  breath();

  const flow = 0.00040 + vLevel*0.0016 + onsetPulse*0.0008;
  const hug  = 0.020 + vClarity*0.055;      // fjederen mod kurven
  const drag = 0.955;
  const crawl = 0.0009 + vLevel*0.0026;     // farten langs kroppen

  const pAge = (millis() - periAt) / 1400;
  const pPos = pAge < 1 ? -1.1 + pAge*2.2 : -9;
  const pAmt = pAge < 1 ? (1 - pAge) * 0.30 : 0;

  const quota = 3 + emit * 55;
  let born = 0;

  const BUCKETS = 5;
  const paths = [];
  for (let i = 0; i < BUCKETS; i++) paths.push([]);

  for (let i = 0; i < cloud.length; i++) {
    const p = cloud[i];

    p.life += p.span * (0.5 + vLevel*0.7);
    if (p.life >= 1) {
      if (emit < 0.03 || born > quota) { p.dead = true; continue; }
      respawn(p); born++;
    }
    if (p.dead) {
      if (emit < 0.03 || born > quota) continue;
      respawn(p); p.life = 0; p.dead = false; born++;
    }

    p.u += crawl;
    bodyAt(p.u, _b);

    // Driften virker paa AFVIGELSEN fra kurven, ikke paa punktet
    _f.x = _b.x + p.ox; _f.y = _b.y + p.oy; _f.z = _b.z + p.oz;
    field(_f, _f);
    p.vx += _f.x*flow; p.vy += _f.y*flow; p.vz += _f.z*flow;

    // Fjederen trakker tilbage mod kurven
    p.vx -= p.ox*hug; p.vy -= p.oy*hug; p.vz -= p.oz*hug;

    // Peristaltikken klemmer afvigelsen ind hvor boelgen er
    if (pAmt > 0.01) {
      const dy = Math.abs(_b.y - pPos);
      if (dy < 0.40) {
        const e = (1 - dy/0.40) * pAmt;
        p.vx -= p.ox*e*0.10; p.vy -= p.oy*e*0.10; p.vz -= p.oz*e*0.10;
      }
    }

    p.vx *= drag; p.vy *= drag; p.vz *= drag;
    p.ox += p.vx; p.oy += p.vy; p.oz += p.vz;

    const X = _b.x + p.ox, Y = _b.y + p.oy, Z = _b.z + p.oz;
    const b = proj(X, Y, Z);
    if (b.s <= 0) { p.px = null; continue; }

    if (p.px === null) { p.px = b.x; p.py = b.y; continue; }

    const env = Math.sin(p.life * PI);
    const dep = constrain((b.s - 0.34) / 0.56, 0, 1);
    const bright = env * (0.14 + dep*0.86) * (0.12 + vFast*0.85);

    if (bright > 0.02) {
      livePts++;
      const bi = min(BUCKETS-1, floor(bright * BUCKETS));
      paths[bi].push(p.px, p.py, b.x, b.y);
    }
    p.px = b.x; p.py = b.y;
  }

  ctx.lineCap = 'round';
  for (let i = 0; i < BUCKETS; i++) {
    const seg = paths[i];
    if (!seg.length) continue;
    const a = max(alive, emit > 0.02 ? 1 : 0.5) * ((i + 1) / BUCKETS) * 0.30;
    ctx.strokeStyle = 'rgba(255,255,255,' + Math.min(1, a).toFixed(3) + ')';
    ctx.lineWidth = 0.4 + i*0.16;
    ctx.beginPath();
    for (let j = 0; j < seg.length; j += 4) {
      ctx.moveTo(seg[j], seg[j+1]);
      ctx.lineTo(seg[j+2], seg[j+3]);
    }
    ctx.stroke();
  }

  /* Accenten: kun svaret, og kun som en anelse — en tynd kopi af
     kroppen lidt uden for den. Bruges accenten kraftigt, holder
     den op med at vaere en accent.                              */
  if (reply > 0.03) {
    ctx.strokeStyle = 'rgba(' + VIS.accent + ',' +
                      Math.min(1, reply*0.22).toFixed(3) + ')';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    let started2 = false;
    for (let i = 0; i <= 240; i++) {
      const u = (i/240) * TWO_PI;
      bodyAt(u, _b);
      const e = 1.10 + reply*0.06;
      const q = proj(_b.x*e, _b.y*e, _b.z*e);
      if (q.s <= 0) { started2 = false; continue; }
      if (!started2) { ctx.moveTo(q.x, q.y); started2 = true; }
      else ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
  }
}

function drawHUD() {
  push(); noStroke(); textAlign(LEFT, TOP); textSize(11);
  if (!started) { pop(); return; }

  fill(F.level > 0 ? 170 : 78, F.level > 0 ? 198 : 78, F.level > 0 ? 230 : 84, 160);

  if (showAll) {
    textAlign(RIGHT, TOP);
    const rows = [
      ['amplitude', nf(F.db,1,1) + ' dB'],
      ['gulv/gate', nf(ampFloor,1,0) + ' / ' + nf(Math.max(ampFloor+CFG.gateDb, CFG.hardGate),1,0)],
      ['trim',      nf(runawayTrim,1,2)],
      ['onset',     nf(F.flux,1,2)],
      ['pitch',     F.clarity > CFG.clarityMin
                      ? nf(F.hz,1,1) + ' Hz  ' + centsLabel(F.hz) : '—'],
      ['klarhed',   nf(F.clarity,1,2)],
      ['centroid',  nf(F.centroid,1,0) + ' Hz'],
      ['pan',       F.stereo ? nf(F.pan,1,2) : 'mono'],
      ['flatness',  nf(F.noisiness,1,2)],
      ['sustain',   nf(F.sustainMs/1000,1,1) + ' s'],
      ['zcr',       nf(F.zcr,1,0) + ' Hz'],
      ['vokal',     F.vowel + ' -> akkord ' + (chordIdx+1)],
      ['lås',       nf(constrain((F.clarity-0.35)/0.45,0,1),1,2)],
      ['vocoder',   nf(Math.pow(F.smooth,1.0)*MIX.voc,1,2) + '  ' + CFG.vocBands + ' bånd'],
      ['hak i alt', (6+10+8+12+6+8+4) + ''],
      ['formant',   nf(0.80 + F.bright*0.55 + F.charge*0.18,1,2) + 'x'],
      ['fejning',   nf(1.6 + F.smooth*2.4 + snap*1.2,1,2) + 'x'],
      ['—','—'],
      ['nærvær',    nf(presence,1,2)],
      ['drone→tone', nf(F.smooth,1,2)],
      ['kor',       nf(F.charge,1,2)],
      ['bas',       noteName(bassNoteFor(freqToMidi(constrain(F.hz,40,900))-12))],
      ['pip',       nf(freeHzHUD * 7.02, 1, 0) + ' Hz'],
      ['ytring',    utt.playing ? 'SVARER ' + utt.idx + '/' + utt.rec.length
                      : (utt.rec.length ? 'optager ' + utt.rec.length : '-')],
      ['punkter',   livePts + ' / ' + VIS.points],
      ['radius',    nf(rad,1,2)],
      ['form',      nf(ra,1,1) + ':' + nf(rb,1,1) + ':' + nf(rc,1,1)],
      ['hale',      nf(CFG.tailMs/1000,1,2) + ' s'],
      ['lead',      nf(leadAmt,1,2) + '  Q' + nf(11 + leadAmt*9 + F.charge*5,1,0)],
      ['akkord',    (chordIdx+1) + ' / ' + PROG.length],
      ['toneart',   noteName(keyRoot)]
    ];
    for (let i = 0; i < rows.length; i++) {
      fill(96,102,114,105);  text(rows[i][0], width-112, 22 + i*15);
      fill(156,166,182,135); text(rows[i][1], width-22, 22 + i*15);
    }
  }
  pop();
}

// Nærmeste tone plus afvigelsen i cents — så du kan synge efter den
function centsLabel(hz) {
  if (!(hz > 0)) return '—';
  const m = freqToMidi(hz);
  const r = Math.round(m);
  const cents = Math.round((m - r) * 100);
  return noteName(r) + ' ' + (cents >= 0 ? '+' : '') + cents + 'c';
}

function noteName(m) {
  const N = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return N[((m % 12) + 12) % 12] + (floor(m/12) - 1);
}