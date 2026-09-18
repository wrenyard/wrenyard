import { runUpdateHelper } from './update-helper.js';

const configPath = process.argv[2];
if (!configPath) {
  process.exitCode = 2;
} else {
  // A rejected config or an unreadable helper config exits distinctly instead
  // of as an unhandled rejection; the durable attempt record holds the reason.
  void runUpdateHelper(configPath).then(
    (code) => { process.exitCode = code; },
    () => { process.exitCode = 3; },
  );
}
