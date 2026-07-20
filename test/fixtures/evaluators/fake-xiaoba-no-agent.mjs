const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("xiaoba 0.1.1-test\n");
  process.exit(0);
}

if (args.join(" ").includes("arena run execute --help")) {
  process.stdout.write("--mode <base_skill|role_skill|role>\n--subject <skill|role>\n");
  process.exit(0);
}

process.exit(2);
