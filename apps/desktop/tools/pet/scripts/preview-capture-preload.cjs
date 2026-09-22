'use strict';

const FIXTURE_ARG_PREFIX = '--preview-fixture=';
const METHOD_NAMES = [
  'onSnapshot',
  'onHouseUpdate',
  'onWorkerUpdate',
  'getConfig',
  'setHouseMousePassthrough',
  'houseDragStart',
  'houseDragMove',
  'houseDragEnd',
  'dismissBroadcast',
  'setWorkerMousePassthrough',
  'workerDragStart',
  'workerDragMove',
  'workerDragEnd',
];

function readFixtureFromArgv(argv) {
  const matches = argv.filter((arg) => arg.startsWith(FIXTURE_ARG_PREFIX));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${FIXTURE_ARG_PREFIX} argument`);
  }
  const raw = matches[0].slice(FIXTURE_ARG_PREFIX.length);
  const json = decodeURIComponent(raw);
  const fixture = JSON.parse(json);
  if (!fixture || (fixture.kind !== 'worker' && fixture.kind !== 'house')) {
    throw new Error('fixture kind must be worker or house');
  }
  if (typeof fixture.file !== 'string' || !fixture.value || typeof fixture.initNowMs !== 'number') {
    throw new Error('fixture is incomplete');
  }
  return fixture;
}

function createInfoCard(worker, initNowMs) {
  const card = {
    workerIdentityKey: worker.workerIdentityKey,
    profile: worker.profile,
    status: worker.phase,
    toolCount: worker.toolCount,
    durationMs: Math.max(0, initNowMs - worker.startedAt),
    isWorktree: false,
  };
  if (worker.taskId !== undefined) card.taskId = worker.taskId;
  if (worker.taskName !== undefined) card.taskName = worker.taskName;
  if (worker.taskLabel !== undefined) card.taskLabel = worker.taskLabel;
  return card;
}

function createPreviewPetApi(fixture) {
  const api = {
    onSnapshot() {
      return noop;
    },
    onHouseUpdate(cb) {
      if (fixture.kind === 'house') cb(fixture.value);
      return noop;
    },
    onWorkerUpdate(cb) {
      if (fixture.kind === 'worker') {
        cb({
          scale: 5,
          worker: fixture.value,
          infoCard: createInfoCard(fixture.value, fixture.initNowMs),
        });
      }
      return noop;
    },
    getConfig() {
      return Promise.resolve({ scale: 5 });
    },
    setHouseMousePassthrough() {},
    houseDragStart() {},
    houseDragMove() {},
    houseDragEnd() {},
    dismissBroadcast() {},
    setWorkerMousePassthrough() {},
    workerDragStart() {},
    workerDragMove() {},
    workerDragEnd() {},
  };
  return api;
}

function noop() {}

function exposePreviewPetApi(argv) {
  const fixture = readFixtureFromArgv(argv);
  const api = createPreviewPetApi(fixture);
  const { contextBridge } = require('electron');
  contextBridge.exposeInMainWorld('petApi', api);
  return api;
}

if (process.type === 'renderer') {
  exposePreviewPetApi(process.argv);
}

module.exports = {
  FIXTURE_ARG_PREFIX,
  METHOD_NAMES,
  readFixtureFromArgv,
  createInfoCard,
  createPreviewPetApi,
  exposePreviewPetApi,
};
