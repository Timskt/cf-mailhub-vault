import ts from 'typescript';
import fs from 'node:fs';
for (const configPath of ['tsconfig.json', 'tsconfig.connector.json', 'tsconfig.web.json']) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const host = {
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: file => String(fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0),
    getScriptSnapshot: file => fs.existsSync(file) ? ts.ScriptSnapshot.fromString(fs.readFileSync(file,'utf8')) : undefined,
    getCurrentDirectory: () => process.cwd(), getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: opts => ts.getDefaultLibFilePath(opts), fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
  };
  const service = ts.createLanguageService(host);
  for (const file of parsed.fileNames) {
    for (const change of service.organizeImports({type:'file',fileName:file},{},{})) {
      let text = fs.readFileSync(change.fileName,'utf8');
      for (const edit of [...change.textChanges].reverse()) text = text.slice(0,edit.span.start)+edit.newText+text.slice(edit.span.start+edit.span.length);
      fs.writeFileSync(change.fileName,text);
    }
  }
  service.dispose();
}
