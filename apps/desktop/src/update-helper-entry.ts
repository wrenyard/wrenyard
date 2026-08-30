import { runUpdateHelper } from './update-helper.js';

const configPath = process.argv[2];
if (!configPath) {
  process.exitCode = 2;
} else {
  void runUpdateHelper(configPath).then((code) => { process.exitCode = code; });
}
