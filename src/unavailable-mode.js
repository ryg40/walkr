export function unavailableMode(mode, args = process.argv.slice(2)) {
  const help = args.length === 1 && ["--help", "-h", "help"].includes(args[0]);
  const message = `walkr-${mode}: not implemented. Use walkr-core for original review or walkr-double --help for local Double guidance.`;
  if (help) console.log(message);
  else { console.error(message); process.exitCode = 1; }
}
