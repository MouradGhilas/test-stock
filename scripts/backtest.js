#!/usr/bin/env node
/**
 * Rejoue le barème sur les publications passées et publie le résultat brut.
 *
 * Usage :
 *   node scripts/backtest.js
 *   node scripts/backtest.js --tickers=AAPL,MSFT --entry=5 --buckets=4
 *   node scripts/backtest.js --out=backtest.json
 */

import { writeFile } from 'node:fs/promises';
import { CONFIG } from '../server/config.js';
import { createTracker } from '../server/core/http.js';
import { fetchHistory } from '../server/sources/nasdaq.js';
import { fetchEarningsFilings } from '../server/sources/edgar.js';
import { buildObservations, summarize, interpret } from '../server/backtest.js';

/**
 * Univers par défaut : grandes capitalisations américaines liquides, réparties
 * entre secteurs. Le but n'est pas la représentativité du marché mais d'avoir
 * assez de publications documentées pour que les statistiques tiennent.
 */
const UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'AVGO', 'ORCL', 'CRM', 'ADBE',
  'AMD', 'INTC', 'QCOM', 'TXN', 'MU', 'AMAT', 'NOW', 'INTU', 'IBM', 'CSCO',
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'AXP', 'V', 'MA', 'BLK', 'SCHW',
  'JNJ', 'UNH', 'PFE', 'MRK', 'ABBV', 'LLY', 'TMO', 'ABT', 'AMGN', 'GILD',
  'WMT', 'COST', 'HD', 'LOW', 'TGT', 'NKE', 'SBUX', 'MCD', 'PG', 'KO',
  'PEP', 'XOM', 'CVX', 'COP', 'CAT', 'DE', 'BA', 'GE', 'HON', 'UPS',
  'DIS', 'NFLX', 'T', 'VZ', 'TSLA', 'F', 'GM', 'UBER', 'PYPL', 'SHOP',
];

function parseArgs(argv) {
  const args = Object.fromEntries(
    argv.filter((a) => a.startsWith('--')).map((a) => {
      const [k, v = 'true'] = a.slice(2).split('=');
      return [k, v];
    }),
  );
  return {
    tickers: args.tickers ? args.tickers.split(',').map((t) => t.trim().toUpperCase()) : UNIVERSE,
    entry: Number(args.entry ?? 3),
    buckets: Number(args.buckets ?? 5),
    years: Number(args.years ?? CONFIG.analysis.earningsHistoryYears),
    out: args.out ?? null,
  };
}

/** Traite les tickers par vagues : le client HTTP plafonne déjà la concurrence. */
async function collect(tickers, { entry, years }) {
  const tracker = createTracker();
  const observations = [];
  const perTicker = [];
  const failures = [];
  const BATCH = 5;

  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (ticker) => {
        try {
          const [bars, filings] = await Promise.all([
            fetchHistory(ticker, tracker),
            fetchEarningsFilings(ticker, tracker, years),
          ]);
          if (!bars?.length || !filings?.length) return { ticker, observations: [] };
          return {
            ticker,
            observations: buildObservations(bars, filings, { entrySessions: entry }),
            sessions: bars.length,
            filings: filings.length,
          };
        } catch (error) {
          return { ticker, error: error.message };
        }
      }),
    );

    for (const r of results) {
      if (r.error) {
        failures.push(`${r.ticker} : ${r.error}`);
        continue;
      }
      observations.push(...r.observations.map((o) => ({ ...o, ticker: r.ticker })));
      perTicker.push({ ticker: r.ticker, events: r.observations.length, sessions: r.sessions });
    }

    process.stderr.write(
      `\r  collecte ${Math.min(i + BATCH, tickers.length)}/${tickers.length} tickers · ${observations.length} publications`,
    );
  }
  process.stderr.write('\n');

  return { observations, perTicker, failures, tracker };
}

const pct = (x) => (typeof x === 'number' ? `${x >= 0 ? '+' : ''}${x.toFixed(2)} %` : '—');
const nb = (x, d = 3) => (typeof x === 'number' ? x.toFixed(d) : '—');

function report(summary, meta) {
  const line = '─'.repeat(78);
  console.log(`\n${line}`);
  console.log("BACKTEST DU BARÈME — réactions aux résultats");
  console.log(line);
  console.log(`Univers            : ${meta.tickers} tickers, ${meta.years} ans d'historique`);
  console.log(`Observations       : ${summary.n} publications exploitables`);
  console.log(`Entrée simulée     : ${meta.entry} séance(s) avant la réaction`);
  console.log(`Facteurs testés    : réactions passées (poids 15) + technique (poids 12)`);
  console.log(`Facteurs absents   : mouvement implicite, révisions, consensus, actualité,`);
  console.log(`                     positions vendeuses, actionnariat — sans historique gratuit`);

  const b = summary.baseline;
  console.log(`\n── Référence, toutes publications confondues`);
  console.log(`   Réaction moyenne      ${pct(b.meanReaction)}   médiane ${pct(b.medianReaction)}`);
  console.log(`   Écart-type            ${nb(b.volatility, 2)} points`);
  console.log(`   Taux de hausse        ${(b.positiveRate * 100).toFixed(1)} %`);
  console.log(`   Position gardée       ${pct(b.meanHold)} en moyenne, ${(b.positiveHoldRate * 100).toFixed(1)} % de gagnantes`);

  const c = summary.correlation;
  console.log(`\n── Le score annonce-t-il la réaction ?`);
  console.log(`   Corrélation de Pearson    ${nb(c.pearsonReaction)}`);
  console.log(`   Corrélation de Spearman   ${nb(c.spearmanReaction)}`);
  console.log(`   Idem sur la position tenue ${nb(c.spearmanHold)}`);

  console.log(`\n── Par tranche de score (de la plus basse à la plus haute)`);
  console.log(`   tranche      n   score        réaction moy.   hausses   position tenue`);
  for (const t of summary.buckets) {
    console.log(
      `      ${t.bucket}      ${String(t.n).padStart(4)}   ` +
      `${t.scoreMin.toFixed(0).padStart(4)}…${t.scoreMax.toFixed(0).padEnd(5)}  ` +
      `${pct(t.meanReaction).padStart(8)}        ` +
      `${(t.positiveRate * 100).toFixed(0).padStart(3)} %      ${pct(t.meanHold)}`,
    );
  }

  if (summary.spread) {
    const s = summary.spread;
    console.log(`\n── Écart tranche haute − tranche basse`);
    console.log(`   ${pct(s.difference)}, erreur standard ${nb(s.standardError, 2)}, t = ${nb(s.tStat, 2)}`);
  }

  console.log(`\n── Lecture`);
  for (const chunk of interpret(summary).match(/.{1,74}(\s|$)/g) || []) {
    console.log(`   ${chunk.trim()}`);
  }
  console.log(`${line}\n`);
}

const options = parseArgs(process.argv.slice(2));
console.error(`Collecte de ${options.tickers.length} tickers sur ${options.years} ans…`);

const { observations, perTicker, failures } = await collect(options.tickers, options);

if (!observations.length) {
  console.error('Aucune observation exploitable. Vérifiez la connectivité des sources.');
  process.exit(1);
}

const summary = summarize(observations, { buckets: options.buckets });
report(summary, { tickers: perTicker.length, years: options.years, entry: options.entry });

if (failures.length) {
  console.log(`Tickers en échec (${failures.length}) : ${failures.slice(0, 5).join(' · ')}`);
}

if (options.out) {
  await writeFile(options.out, JSON.stringify({ summary, observations, perTicker, failures }, null, 2));
  console.log(`Détail écrit dans ${options.out}`);
}
