import fs from "node:fs";
import path from "node:path";

export class JsonFileStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly defaultValue: T
  ) {}

  load(): T {
    const absolutePath = path.resolve(this.filePath);
    if (!fs.existsSync(absolutePath)) {
      this.save(this.defaultValue);
      return structuredClone(this.defaultValue);
    }

    return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as T;
  }

  save(value: T): void {
    const absolutePath = path.resolve(this.filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify(value, null, 2));
  }

  update(mutator: (value: T) => T): T {
    const nextValue = mutator(this.load());
    this.save(nextValue);
    return nextValue;
  }
}
