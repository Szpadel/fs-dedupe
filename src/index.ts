import * as cmd from 'commandpost';
import crypto from 'crypto';
import * as fs from 'fs-extra-promise';
import glob from 'glob';
import path from 'path';

interface Options {
    dryRun: boolean;
    pattern: string[];
}

interface Args {
    dir: string;
}

class DiscoveredFile {
    private calculatedSha1?: string;
    constructor(public readonly path: string) {}

    async sha1(): Promise<string> {
        if (!this.calculatedSha1) {
            const buf = await fs.readFileAsync(this.path);
            this.calculatedSha1 =
                crypto.createHash('sha1').update(buf).digest('hex');
        }
        return this.calculatedSha1;
    }
}

class Scanner {
    constructor(protected rootDir: string, protected patterns: string[]) {
        if (this.patterns.length === 0) {
            this.patterns.push('*');
        }
    }

    async scanFiles(): Promise<DiscoveredFile[]> {
        return new Promise((resolve, reject) => {
            const filter = `**/+(${this.patterns.join('|')})`;
            glob(
                filter, {
                    cwd: '.',
                    nodir: true,
                    follow: false,
                    realpath: true,
                },
                (err, matches) => {
                    if (err) {
                        reject(err);
                    }
                    resolve(matches.map(p => new DiscoveredFile(p)));
                });
        });
    }
}

class Main {
    private duplicatesMap: Map<string, DiscoveredFile[]> = new Map();
    async run(options: Options, args: Args) {
        process.chdir(args.dir);
        console.log(`Scanning...`);
        const scanner = new Scanner(args.dir, options.pattern);
        const files = await scanner.scanFiles();
        const totalFiles = files.length;
        console.log(`Matched ${totalFiles} files`);
        console.log(`Looking for duplicates...`);
        await this.populateDuplicates(files);
        const uniqueFiles = this.duplicatesMap.size;
        console.log(`Found ${uniqueFiles} unique files`);
        this.removeUnique();
        const duplicatedSourceFiles = this.duplicatesMap.size;
        console.log(`Found ${duplicatedSourceFiles} files with ${
            totalFiles - uniqueFiles - duplicatedSourceFiles} copies`);
        if (options.dryRun) {
            this.printDuplicates();
        } else {
            if (duplicatedSourceFiles === 0) {
                console.log(`Nothing to dedupe ¯\\_(ツ)_/¯`);
            } else {
                console.log(`Creating symlinks...`);
                await this.createSymlinks();
                console.log(`Deduplication finished`);
            }
        }
    }

    private printDuplicates() {
        for (const duplicates of this.duplicatesMap.values()) {
            const [src, ...dupes] = duplicates;
            for (const dupe of dupes) {
                console.log(
                    dupe.path, ' ->',
                    path.relative(path.dirname(dupe.path), src.path));
            }
        }
    }

    private async createSymlinks() {
        await Promise.all([...this.duplicatesMap.values()].map(
            d => this.createSymlinksForDuplicate(d)));
    }

    private async createSymlinksForDuplicate(duplicates: DiscoveredFile[]) {
        const [src, ...dupes] = duplicates;
        for (const dupe of dupes) {
            await fs.unlinkAsync(dupe.path);
            await fs.symlinkAsync(
                path.relative(path.dirname(dupe.path), src.path), dupe.path,
                'file');
        }
    }
    private async detectDuplicate(file: DiscoveredFile) {
        const sha = await file.sha1();
        let list = this.duplicatesMap.get(sha);
        if (!list) {
            list = [];
            this.duplicatesMap.set(sha, list);
        }
        list.push(file);
    }

    private async populateDuplicates(files: DiscoveredFile[]) {
        await Promise.all(files.map(f => this.detectDuplicate(f)));
    }

    private removeUnique() {
        for (const sha of this.duplicatesMap.keys()) {
      if(this.duplicatesMap.get(sha)?.length === 1) {
          this.duplicatesMap.delete(sha);
      }
        }
    }
}

const cli =
    cmd.create<Options, Args>('dedupe <dir>')
        .version('0.1.0', '-v, --version')
        .description('Deduplicate files by creating symlinks')
        .option('-n, --dry-run', 'Dry run, only print found duplicates')
        .option(
            '-e, --pattern <glob>',
            'Filename patterns to deduplicate (can be passed multiple times)')
        .action(async (options, args) => await (new Main()).run(options, args));


cmd.exec(cli, process.argv).catch(err => {
    if (err instanceof cmd.CommandpostError) {
        console.error(`Error: ${err.message}`);
    } else if (err instanceof Error) {
        console.error(err.stack);
    } else {
        console.error(err);
    }
    process.exit(1);
});