import { html, render } from "https://unpkg.com/lit-html@3.1.0/lit-html.js";
import dayjs from "https://unpkg.com/dayjs@1.11.10/esm/index.js";
import utc from "https://unpkg.com/dayjs@1.11.10/esm/plugin/utc/index.js"

dayjs.extend(utc);

class SQL {
    constructor() {
        this.db = null;
        this.id = 1;
        this.queries = {};
        this.init();
    }

    async init() {
        this.db = new Worker("/static/worker.sql-wasm.js");
        this.db.onmessage = () => {
            console.log("SQL: database opened");
            this.db.onmessage = event => {
                const { id, results } = event.data;
                if (id in this.queries){
                    if (id.startsWith("logs-")){
                        const logs = {};
                        if (results?.length && results[0]?.columns?.length && results[0]?.values?.length){
                            const mixedResults = results[0];
                            for (const row of mixedResults.values){
                                const log = {
                                    branch: "",
                                    category: "",
                                    env: "",
                                    file: "",
                                    function: "",
                                    level: "",
                                    line: 0,
                                    message: "",
                                    timestamp: "",
                                    uid: "",
                                    custom: {},
                                };
                                for (let i = 0; i < mixedResults.columns.length; i++){
                                    if (mixedResults.columns[i] in log){
                                        log[mixedResults.columns[i]] = row[i];
                                    } else if (mixedResults.columns[i] === "key" && row[i] !== null) {
                                        log.custom[row[i]] = row[i + 1];
                                    }
                                }
                                logs[log.uid] = log;
                            }
                        }
                        const records = Object.values(logs) ?? [];
                        console.log("SQL: query resolved", this.queries[id].sql, this.queries[id].params, records);
                        this.queries[id].resolve(records);
                    } else {
                        const records = [];
                        if (results?.length && results[0]?.columns?.length && results[0]?.values?.length){
                            const mixedResults = results[0];
                            for (const row of mixedResults.values){
                                const record = {};
                                for (let i = 0; i < mixedResults.columns.length; i++){
                                    record[mixedResults.columns[i]] = row[i];
                                }
                                records.push(record);
                            }
                        }
                        console.log("SQL: query resolved", this.queries[id].sql, this.queries[id].params, records);
                        this.queries[id].resolve(records);
                    }
                    delete this.queries[id];
                }
            };
        };
        this.db.onerror = e => console.log("Worker error: ", e);
        this.db.postMessage({
            id:1,
            action:"open",
        });
    }

    async createTables() {
        await this.send(`
            CREATE TABLE logs (
                branch TEXT,
                category TEXT,
                env TEXT,
                file TEXT,
                function TEXT,
                level TEXT,
                line INTEGER,
                message TEXT,
                timestamp TEXT,
                uid TEXT PRIMARY KEY
            );
            CREATE TABLE custom (
                logId TEXT,
                key TEXT,
                value TEXT
            );
        `);
    }

    async resetTables() {
        await this.send(`
            DROP TABLE logs;
            DROP TABLE custom;
        `);
        await this.createTables();
    }

    send(sql, params = {}) {this.id++;
        return new Promise((resolve, reject) => {
            const id = `query-${this.id++}`;
            sql = sql.replace(/\n/g, "").replace(/\s+/g, " ").trim();
            this.queries[id] = { resolve, reject, sql, params };
            this.db.postMessage({
                id: id,
                action: "exec",
                sql: sql,
                params: params
            });
        });
    }

    queryLogs(sql, params = {}) {
        return new Promise((resolve, reject) => {
            const id = `logs-${this.id++}`;
            sql = sql.replace(/\n/g, "").replace(/\s+/g, " ").trim();
            this.queries[id] = { resolve, reject, sql, params };
            this.db.postMessage({
                id: id,
                action: "exec",
                sql: sql,
                params: params
            });
        });
    }
}
const sql = new SQL();

class LogParser {
    ingest(file) {
        return new Promise(async (resolve, reject) => {
            const worker = new Worker("/static/worker.log-parser.js");
            const promises = [];
            try {
                worker.onmessage = async (e) => {
                    const { result, type } = e.data;
                    switch (type) {
                        case "result":
                            promises.push(sql.send(`
                                INSERT INTO logs (branch, category, env, file, function, level, line, message, timestamp, uid) 
                                VALUES ($branch, $category, $env, $file, $function, $level, $line, $message, $timestamp, $uid)
                            `, {
                                "$branch": result.branch,
                                "$category": result.category,
                                "$env": result.env,
                                "$file": result.file,
                                "$function": result.function,
                                "$level": result.level,
                                "$line": result.line,
                                "$message": result.message,
                                "$timestamp": result.timestamp,
                                "$uid": result.uid,
                            }));
                            for (const key in result.custom){
                                promises.push(sql.send(`
                                    INSERT INTO custom (logId, key, value) 
                                    VALUES ($logId, $key, $value)
                                `, {
                                    "$logId": result.uid,
                                    "$key": key,
                                    "$value": result.custom[key],
                                }));
                            }
                            break;
                        case "done":
                            worker.terminate();
                            await Promise.all(promises);
                            resolve();
                            break;
                        default:
                            break;
                    }
                };
                worker.postMessage({
                    url: file,
                    args: {},
                });
            } catch (e) {
                console.error(e);
                worker.terminate();
                reject(e);
            }
        });
    }
}
const parser = new LogParser();

class TableComponent extends HTMLElement{
    constructor(){
        super();
        this.loading = false;
        this.page = 0;
        this.pageSize = 100;
        this.timezone = localStorage.getItem("timezone") || "UTC";
        this.search = null;
    }
    connectedCallback(){
        this.columnsEl = document.body.querySelector("table-column-editor");
        this.levelsEl = document.body.querySelector("level-button");
        this.categoriesEl = document.body.querySelector("category-button");
        this.environmentsEl = document.body.querySelector("environment-button");
        window.addEventListener("file-selected", async (e) => {
            if (this.loading) return;
            this.loading = true;
            this.app = e.detail.app;
            this.file = e.detail.file;
            await sql.resetTables();
            await parser.ingest(`/logs/${this.app}/${this.file}`);
            this.loading = false;
            window.dispatchEvent(new CustomEvent("file-loaded", {
                detail: e.detail,
            }));
            this.render();
        });
        window.addEventListener("table-refresh", async () => {
            if (this.loading) return;
            this.loading = true;
            this.page = 0;
            this.search = null;
            await sql.resetTables();
            this.render();
            await parser.ingest(`/logs/${this.app}/${this.file}`);
            this.loading = false;
            this.render();
        });
        window.addEventListener("timezone-changed", (e) => {
            this.timezone = e.detail.timezone;
            this.render();
        });
        window.addEventListener("columns-changed", () => {
            this.render();
        });
        window.addEventListener("levels-changed", () => {
            this.render();
        });
        window.addEventListener("categories-changed", () => {
            this.render();
        });
        window.addEventListener("environments-changed", () => {
            this.render();
        });
        window.addEventListener("search-results", (e) => {
            this.search = e.detail;
            this.render();
        });
        window.addEventListener("table-pagination", (e) => {
            this.page = e.detail.page;
            this.render();
        });
        this.render();
    }

    handleBranchClick = async (e) => {
        e.stopImmediatePropagation();
        const target = e.currentTarget;
        const logs = await sql.queryLogs(`
                SELECT l.*, c.key, c.value
                FROM logs l
                FULL OUTER JOIN custom c ON l.uid = c.logId
                WHERE l.branch = '${target.dataset.branch}'
                ORDER BY l.timestamp DESC
            `);
        if (logs.lenght === 0) return;
        const windowEl = document.body.querySelector(`window-component[window="${target.dataset.branch}"]`) || new WindowComponent({
            name: `Branch - ${target.dataset.branch}`,
            width: 550,
            height: 400,
            handle: target.dataset.branch,
            view: html`
                <div class="block w-full p-1.5">
                    ${logs.map((log, i) => {
                        let timestamp;
                        if (this.timezone == "local"){
                            timestamp = dayjs(log.timestamp).format("YYYY-MM-DD HH:mm:ss");
                        } else {
                            timestamp = dayjs(log.timestamp).utc().format("YYYY-MM-DD HH:mm:ss");
                        }
                        return html`
                            <div class="log-accordion">
                                <input type="checkbox" ?checked=${i === 0} id="${log.uid}">
                                <label for="${log.uid}">
                                    <div class="header w-full p-1.5" flex="row nowrap items-center justify-between">
                                        <h4>${log.level} - ${timestamp}</h4>
                                        <svg class="up" xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 13v-8l-3 3m6 0l-3 -3" /><path d="M9 17l1 0" /><path d="M14 17l1 0" /><path d="M19 17l1 0" /><path d="M4 17l1 0" /></svg>
                                        <svg class="down" xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 11v8l3 -3m-6 0l3 3" /><path d="M9 7l1 0" /><path d="M14 7l1 0" /><path d="M19 7l1 0" /><path d="M4 7l1 0" /></svg>
                                    </div>
                                </label>
                                <div class="log">
                                    <dl grid="rows 1 gap-1.5" class="mb-1.5">
                                        <div grid="columns 2 gap-1.5">
                                            <div>
                                                <dt>Level</dt>
                                                <dd>${log.level}</dd>
                                            </div>
                                            <div>
                                                <dt>Timestamp</dt>
                                                <dd>${timestamp}</dd>
                                            </div>
                                        </div>
                                        <div grid="columns 2 gap-1.5">
                                            <div>
                                                <dt>Category</dt>
                                                <dd>${log.category}</dd>
                                            </div>
                                            <div>
                                                <dt>Env</dt>
                                                <dd>${log.env}</dd>
                                            </div>
                                        </div>
                                        ${log.file.length ? 
                                            html`
                                                <div>
                                                    <dt>File</dt>
                                                    <dd>${log.file}</dd>
                                                </div>
                                            ` 
                                            : ""
                                        }
                                        ${log.function.length || log.line !== null ? html`
                                                <div grid="columns 2 gap-1.5">
                                                    <div>
                                                        <dt>Function</dt>
                                                        <dd>${log.function}</dd>
                                                    </div>
                                                    <div>
                                                        <dt>Line</dt>
                                                        <dd>${log.line || ""}</dd>
                                                    </div>
                                                </div>
                                            ` 
                                            : ""
                                        }
                                    </dl>
                                    <h4>Message</h4>
                                    <p>${log.message}</p>
                                </div>
                            </div>
                        `;
                    })}
                </div>
            `
        });
        if (!windowEl.isConnected){
            document.body.appendChild(windowEl);
        } else {
            windowEl.focus();
        }
    }

    handleRowClick = async (e) => {
        const target = e.currentTarget;
        const log = (await sql.queryLogs(`
                SELECT l.*, c.key, c.value
                FROM logs l
                FULL OUTER JOIN custom c ON l.uid = c.logId
                WHERE l.uid = '${target.dataset.uid}'
            `))?.[0] ?? null;
        if (log === null) return;
        let timestamp;
        if (this.timezone == "local"){
            timestamp = dayjs(log.timestamp).format("YYYY-MM-DD HH:mm:ss");
        } else {
            timestamp = dayjs(log.timestamp).utc().format("YYYY-MM-DD HH:mm:ss");
        }
        const windowEl = document.body.querySelector(`window-component[window="${target.dataset.uid}"]`) || new WindowComponent({
            name: `${log.level} - ${timestamp}`,
            width: 550,
            height: 400,
            handle: target.dataset.uid,
            view: html`
                <div class="log">
                    <dl grid="rows 1 gap-1.5" class="mb-1.5">
                        <div grid="columns 2 gap-1.5">
                            <div>
                                <dt>Level</dt>
                                <dd>${log.level}</dd>
                            </div>
                            <div>
                                <dt>Timestamp</dt>
                                <dd>${timestamp}</dd>
                            </div>
                        </div>
                        <div grid="columns 2 gap-1.5">
                            <div>
                                <dt>Category</dt>
                                <dd>${log.category}</dd>
                            </div>
                            <div>
                                <dt>Env</dt>
                                <dd>${log.env}</dd>
                            </div>
                        </div>
                        ${log.file.length ? 
                            html`
                                <div>
                                    <dt>File</dt>
                                    <dd>${log.file}</dd>
                                </div>
                            ` 
                            : ""
                        }
                        ${log.function.length || log.line !== null ? html`
                                <div grid="columns 2 gap-1.5">
                                    <div>
                                        <dt>Function</dt>
                                        <dd>${log.function}</dd>
                                    </div>
                                    <div>
                                        <dt>Line</dt>
                                        <dd>${log.line || ""}</dd>
                                    </div>
                                </div>
                            ` 
                            : ""
                        }
                    </dl>
                    <h4>Message</h4>
                    <p>${log.message}</p>
                </div>
            `
        });
        if (!windowEl.isConnected){
            document.body.appendChild(windowEl);
        } else {
            windowEl.focus();
        }
    }

    renderRow(log, columns, i){
        let timestamp;
        if (this.timezone == "local"){
            timestamp = dayjs(log.timestamp).format("YYYY-MM-DD HH:mm:ss");
        } else {
            timestamp = dayjs(log.timestamp).utc().format("YYYY-MM-DD HH:mm:ss");
        }
        return html`
            <tr style="opacity:0;animation-delay: ${i * 25}ms" tabindex="0" @click=${this.handleRowClick} data-uid="${log["uid"]}" data-level="${log["level"]}" data-timestamp="${timestamp}">
                ${columns.map(column => {
                    if (!column.show) return "";
                    if (column.col === "level"){
                        return html`
                            <td col="level" level="${log.level.toLowerCase()}">
                                <div flex="row nowrap items-center">
                                    <svg xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="currentColor"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 2c5.523 0 10 4.477 10 10a10 10 0 0 1 -19.995 .324l-.005 -.324l.004 -.28c.148 -5.393 4.566 -9.72 9.996 -9.72zm0 9h-1l-.117 .007a1 1 0 0 0 0 1.986l.117 .007v3l.007 .117a1 1 0 0 0 .876 .876l.117 .007h1l.117 -.007a1 1 0 0 0 .876 -.876l.007 -.117l-.007 -.117a1 1 0 0 0 -.764 -.857l-.112 -.02l-.117 -.006v-3l-.007 -.117a1 1 0 0 0 -.876 -.876l-.117 -.007zm.01 -3l-.127 .007a1 1 0 0 0 0 1.986l.117 .007l.127 -.007a1 1 0 0 0 0 -1.986l-.117 -.007z" /></svg>
                                    <span>${log.level}</span>
                                </div>
                            </td>
                        `;
                    } else if (column.col === "message") {
                        return html`
                            <td col="${column.col}">${log[column.col].substring(0, 100).trim()}${log[column.col].length > 100 ? '...' : ''}</td>
                        `;
                    } else if (column.col === "timestamp") {
                        return html`
                            <td col="${column.col}">${timestamp}</td>
                        `;
                    } else if (column.col === "branch") {
                        if (log[column.col].length) {
                            return html`
                                <td col="${column.col}">
                                    ${log[column.col]}
                                    <button @click=${this.handleBranchClick} data-branch="${log[column.col]}">
                                        <svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M6 3v8.707" /><path d="M16 14l4 -4l-4 -4" /><path d="M6 21c0 -6.075 4.925 -11 11 -11h3" /></svg>
                                    </button>
                                </td>
                            `;
                        } else {
                            return html`
                                <td col="${column.col}">${log[column.col]}</td>
                            `;
                        }
                    } else if (column.col in log) {
                        return html`
                            <td col="${column.col}">${log[column.col]}</td>
                        `;
                    } else if (column.col in log.custom) {
                        return html`
                            <td col="${column.col}">${log.custom[column.col]}</td>
                        `;
                    }
                    return html`
                        <td col="${column.col}"></td>
                    `;
                })}
            </tr>
        `;
    }

    async render(){
        if (!this.app || !this.file) {
            document.title = "Lumberjack";
            return;
        }
        document.title = `${this.file} · ${this.app} · Lumberjack`;
        const levels = await this.levelsEl.getLevels() ?? [];
        const categories = await this.categoriesEl.getCategories() ?? [];
        const environments = await this.environmentsEl.getEnvironments() ?? [];
        let logs = [];
        let total = 0;
        if (this.search?.length){
            const where = ` 
                WHERE l.level IN (${levels.filter(level => level.show).map(level => `'${level.name}'`).join(", ")})
                AND l.category IN (${categories.filter(cat => cat.show).map(cat => `'${cat.name}'`).join(", ")})
                AND l.env IN (${environments.filter(env => env.show).map(env => `'${env.name}'`).join(", ")})
                AND l.uid IN (${this.search.map(log => `'${log}'`).join(", ")})
            `;
            logs = await sql.queryLogs(`
                SELECT l.*, c.key, c.value
                FROM logs l
                FULL OUTER JOIN custom c ON l.uid = c.logId
                ${where}
                ORDER BY l.timestamp DESC 
                LIMIT ${this.page * this.pageSize}, ${this.pageSize}
            `) ?? [];
            total = (await sql.send(`
                SELECT COUNT(*) as total
                FROM logs l
                FULL OUTER JOIN custom c ON l.uid = c.logId
                ${where}
            `))?.[0]?.total ?? 0;
        } else if (this.search === null){
            const where = `
                WHERE l.level IN (${levels.filter(level => level.show).map(level => `'${level.name}'`).join(", ")})
                AND l.category IN (${categories.filter(cat => cat.show).map(cat => `'${cat.name}'`).join(", ")})
                AND l.env IN (${environments.filter(env => env.show).map(env => `'${env.name}'`).join(", ")})
            `;
            logs = await sql.queryLogs(`
                SELECT l.*, c.key, c.value
                FROM logs l
                FULL OUTER JOIN custom c ON l.uid = c.logId
                ${where}
                ORDER BY l.timestamp DESC 
                LIMIT ${this.page * this.pageSize}, ${this.pageSize}
            `) ?? [];
            total = (await sql.send(`
                SELECT COUNT(*) as total
                FROM logs l
                FULL OUTER JOIN custom c ON l.uid = c.logId
                ${where}
            `))?.[0]?.total ?? 0;
        }
        const columns = await this.columnsEl?.getColumns() ?? [];
        const view = html`
            <table>
                <thead>
                    <tr>
                        ${columns.map(column => {
                            if (!column.show) return "";
                            return html`
                                <th>${column.col}</th>
                            `;
                        })}
                    </tr>
                </thead>
                <tbody>
                    ${logs.map((log, i) => this.renderRow(log, columns, i))}
                </tbody>
            </table>
        `;
        render(view, this);
        console.log("Table rendered", this.page, total, logs.length);
        window.dispatchEvent(new CustomEvent("table-rendered", { detail: { page: this.page, total: total, logs: logs.length } }));
    }
}

class TableColumnEditor extends HTMLElement {
    constructor(){
        super();
        this.columns = [];
        this.app = "";
        this.file = "";
    }

    connectedCallback(){
        window.addEventListener("file-loaded", async (e) => {
            this.app = e.detail.app;
            this.file = e.detail.file;
            this.render();
        });
    }

    async getColumns(){
        let cachedColumns = localStorage.getItem(`${this.app}-columns`) || "[]";
        cachedColumns = JSON.parse(cachedColumns);
        let columns = await sql.send("SELECT * FROM logs LIMIT 1");
        if (columns.length){
            columns = Object.keys(columns[0]);
        }
        if (!columns.length) return;
        let customColumns = await sql.send("SELECT DISTINCT key FROM custom");
        for (let i = 0; i < customColumns.length; i++){
            columns.push(customColumns[i].key);
        }
        for (let i = 0; i < columns.length; i++){
            const index = cachedColumns.findIndex(col => col.col === columns[i]);
            if (index === -1) {
                cachedColumns.push({
                    col: columns[i],
                    show: true,
                });
            }
        }
        this.columns = cachedColumns;
        localStorage.setItem(`${this.app}-columns`, JSON.stringify(this.columns));
        return cachedColumns;
    }

    handleChange = (e) => {
        const column = e.target.name;
        const show = e.target.checked;
        const index = this.columns.findIndex(col => col.col === column);
        this.columns[index].show = show;
        localStorage.setItem(`${this.app}-columns`, JSON.stringify(this.columns));
        window.dispatchEvent(new CustomEvent("columns-changed"));
    }

    async render(){
        if (!this.app || !this.file) return;
        await this.getColumns();
        const view = html`
            <label>Columns</label>
            <ul>
                ${this.columns.map(column => html`
                    <li>
                        <svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M18 9l3 3l-3 3" /><path d="M15 12h6" /><path d="M6 9l-3 3l3 3" /><path d="M3 12h6" /><path d="M9 18l3 3l3 -3" /><path d="M12 15v6" /><path d="M15 6l-3 -3l-3 3" /><path d="M12 3v6" /></svg>
                        <input @change=${this.handleChange} type="checkbox" id="${column.col}" name="${column.col}" ?checked=${column.show}>
                        <label for="${column.col}">${column.col}</label>
                    </li>
                `)}
            </ul>
        `;
        render(view, this);
        new Sortable(this.querySelector("ul"), {
            animation: 150,
            handle: 'svg',
            onUpdate: (e) => {
                this.columns = Array.from(this.querySelectorAll("li")).map((li, i) => {
                    return {
                        col: li.querySelector("input").name,
                        show: li.querySelector("input").checked,
                    };
                });
                localStorage.setItem(`${this.app}-columns`, JSON.stringify(this.columns));
                window.dispatchEvent(new CustomEvent("columns-changed"));
            }
        });
    }
}

class LevelButton extends HTMLElement {
    constructor(){
        super();
        this.app = "";
        this.file = "";
        this.levels = [];
    }

    connectedCallback(){
        this.menuEl = this.querySelector("ul");
        window.addEventListener("file-loaded", async (e) => {
            this.app = e.detail.app;
            this.file = e.detail.file;
            this.render();
        });
    }

    async getLevels(){
        let levels = await sql.send("SELECT DISTINCT level FROM logs") ?? [];
        let cachedLevels = localStorage.getItem(`${this.app}-levels`) || "[]";
        cachedLevels = JSON.parse(cachedLevels);
        for (let i = 0; i < levels.length; i++){
            const index = cachedLevels.findIndex(l => l.name === levels[i].level);
            if (index === -1){
                cachedLevels.push({
                    name: levels[i].level,
                    show: true,
                });
            }
        }
        this.levels = cachedLevels;
        localStorage.setItem(`${this.app}-levels`, JSON.stringify(this.levels));
        return this.levels;
    }

    handleChange = (e) => {
        e.stopImmediatePropagation();
        const level = e.target.name;
        const show = e.target.checked;
        const index = this.levels.findIndex(l => l.name === level);
        this.levels[index].show = show;
        localStorage.setItem(`${this.app}-levels`, JSON.stringify(this.levels));
        window.dispatchEvent(new CustomEvent("levels-changed"));
    }

    async render() {
        if (!this.app || !this.file) return;
        const levels = await this.getLevels();
        const view = html`
            ${levels.map(level => html`
                <li>
                    <input @change=${this.handleChange} type="checkbox" id="${level.name}" name="${level.name}" ?checked=${level.show}>
                    <label for="${level.name}">${level.name}</label>
                </li>
            `)}
        `;
        render(view, this.menuEl);
        this.removeAttribute("disabled");
    }
}

class CategoryButton extends HTMLElement {
    constructor(){
        super();
        this.app = "";
        this.file = "";
        this.categories = [];
    }

    connectedCallback(){
        this.menuEl = this.querySelector("ul");
        window.addEventListener("file-loaded", async (e) => {
            this.app = e.detail.app;
            this.file = e.detail.file;
            this.render();
        });
    }

    async getCategories(){
        let categories = await sql.send("SELECT DISTINCT category FROM logs") ?? [];
        let cachedCategories = localStorage.getItem(`${this.app}-categories`) || "[]";
        cachedCategories = JSON.parse(cachedCategories);
        for (let i = 0; i < categories.length; i++){
            const index = cachedCategories.findIndex(c => c.name === categories[i].category);
            if (index === -1){
                cachedCategories.push({
                    name: categories[i].category,
                    show: true,
                });
            }
        }
        this.categories = cachedCategories;
        localStorage.setItem(`${this.app}-categories`, JSON.stringify(this.categories));
        return this.categories;
    }

    handleChange = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        const category = e.target.name;
        const show = e.target.checked;
        const index = this.categories.findIndex(c => c.name === category);
        this.categories[index].show = show;
        localStorage.setItem(`${this.app}-categories`, JSON.stringify(this.categories));
        window.dispatchEvent(new CustomEvent("categories-changed"));
    }

    async render() {
        if (!this.app || !this.file) return;
        const categories = await this.getCategories();
        const view = html`
            ${categories.map(cat => html`
                <li>
                    <input @change=${this.handleChange} type="checkbox" id="${cat.name}" name="${cat.name}" ?checked=${cat.show}>
                    <label for="${cat.name}">${cat.name}</label>
                </li>
            `)}
        `;
        render(view, this.menuEl);
        this.removeAttribute("disabled");
    }
}

class EnvironmentButton extends HTMLElement {
    constructor(){
        super();
        this.app = "";
        this.file = "";
        this.environments = [];
    }

    connectedCallback(){
        this.menuEl = this.querySelector("ul");
        window.addEventListener("file-loaded", async (e) => {
            this.app = e.detail.app;
            this.file = e.detail.file;
            this.render();
        });
    }

    async getEnvironments(){
        let envs = await sql.send("SELECT DISTINCT env FROM logs") ?? [];
        let cachedEnvs = localStorage.getItem(`${this.app}-environments`) || "[]";
        cachedEnvs = JSON.parse(cachedEnvs);
        for (let i = 0; i < envs.length; i++){
            const index = cachedEnvs.findIndex(e => e.name === envs[i].env);
            if (index === -1){
                cachedEnvs.push({
                    name: envs[i].env,
                    show: true,
                });
            }
        }
        this.environments = cachedEnvs;
        localStorage.setItem(`${this.app}-environments`, JSON.stringify(this.environments));
        return this.environments;
    }

    handleChange = (e) => {
        e.stopImmediatePropagation();
        const env = e.target.name;
        const show = e.target.checked;
        const index = this.environments.findIndex(e => e.name === env);
        this.environments[index].show = show;
        localStorage.setItem(`${this.app}-environments`, JSON.stringify(this.environments));
        window.dispatchEvent(new CustomEvent("environments-changed"));
    }

    async render() {
        if (!this.app || !this.file) return;
        const envs = await this.getEnvironments();
        const view = html`
            ${envs.map(env => html`
                <li>
                    <input @change=${this.handleChange} type="checkbox" id="${env.name}" name="${env.name}" ?checked=${env.show}>
                    <label for="${env.name}">${env.name}</label>
                </li>
            `)}
        `;
        render(view, this.menuEl);
        this.removeAttribute("disabled");
    }
}

class MessageSearch extends HTMLElement {
    constructor(){
        super();
        this.app = "";
        this.file = "";
        this.currReqId = 0;
    }

    connectedCallback(){
        this.inputEl = this.querySelector("input");
        this.inputEl.addEventListener("input", this.handleInput);
        window.addEventListener("file-loaded", async (e) => {
            this.app = e.detail.app;
            this.file = e.detail.file;
            this.removeAttribute("disabled");
            this.inputEl.value = "";
            this.inputEl.removeAttribute("disabled");
        });
    }

    debounce = (callback, wait) => {
        let timeoutId = null;
        return (...args) => {
            window.clearTimeout(timeoutId);
            timeoutId = window.setTimeout(() => {
                callback.apply(null, args);
            }, wait);
        };
    }

    handleInput = this.debounce(async (e) => {
        const query = e.target.value.trim();
        if (!query) {
            window.dispatchEvent(new CustomEvent("search-results", { detail: null }));
            return;
        }
        if (!this.app || !this.file) return;
        const requestId = ++this.currReqId;
        const req = await fetch(`/search/${this.app}/${this.file}`, {
            method: "POST",
            body: query.trim(),
        });
        if (requestId !== this.currReqId) return;
        if (req.ok){
            const res = await req.json();
            console.log("Search results", res);
            window.dispatchEvent(new CustomEvent("search-results", { detail: res }));
        }
    }, 600);
}

class FileSize extends HTMLElement {
    constructor(){
        super();
        this.app = "";
        this.file = "";
    }

    connectedCallback(){
        window.addEventListener("file-loaded", async (e) => {
            this.app = e.detail.app;
            this.file = e.detail.file;
            this.render();
        });
    }

    async render(){
        if (!this.app || !this.file) return;
        const req = await fetch(`/size/${this.app}/${this.file}`);
        if (req.ok){
            const size = await req.text();
            this.innerHTML = size;
        }
    }
}

class WindowComponent extends HTMLElement {
    constructor(settings){
        super();
        this.handle = settings?.handle ?? settings.name.toLowerCase().trim().replace(/\s+/g, "-");

        this.minWidth = settings?.minWidth ?? 100;
        this.minHeight = settings?.minHeight ?? 50;

        const savedWidth = localStorage.getItem(`${this.handle}-w`);
        const savedHeight = localStorage.getItem(`${this.handle}-h`);
        if (savedWidth != null && savedHeight != null){
            this.w = parseInt(savedWidth);
            this.h = parseInt(savedHeight);
        } else {
            this.w = settings?.width ?? this.minWidth;
            this.h = settings?.height ?? this.minHeight;
        }
        if (savedWidth == null){
            localStorage.setItem(`${this.handle}-w`, this.w.toFixed(0).toString());
        }
        if (savedHeight == null){
            localStorage.setItem(`${this.handle}-h`, this.h.toFixed(0).toString());
        }

        const savedX = localStorage.getItem(`${this.handle}-x`);
        const savedY = localStorage.getItem(`${this.handle}-y`);
        this.x = savedX ? parseInt(savedX) : Math.max((window.innerWidth - this.w) / 2, 0);
        this.y = savedY ? parseInt(savedY) : Math.max((window.innerHeight - this.h) / 2, 0);
        if (savedX == null){
            localStorage.setItem(`${this.handle}-x`, this.x.toFixed(0).toString());
        }
        if (savedY == null){
            localStorage.setItem(`${this.handle}-y`, this.y.toFixed(0).toString());
        }

        this.enableControls = settings?.enableControls ?? true;

        this.resize();

        this.style.transform = `translate(${this.x}px, ${this.y}px)`;
        this.view = settings.view;
        this.name = settings.name;
        this.moving = false;
        this.size =  "normal";
    }

    connectedCallback() {
        this.render();
        this.focus();
        window.addEventListener("mouseup", this.stopMove, { capture: true, passive: true });
        window.addEventListener("mousemove", this.move, { capture: true, passive: true });
        window.addEventListener("touchend", this.stopMove, { capture: true, passive: true });
        window.addEventListener("touchmove", this.move, { capture: true, passive: true });
        window.addEventListener("resize", this.debounce(this.resizeEvent, 300), { capture: true, passive: true });
    }

    debounce = (callback, wait) => {
        let timeoutId = null;
        return (...args) => {
            window.clearTimeout(timeoutId);
            timeoutId = window.setTimeout(() => {
                callback.apply(null, args);
            }, wait);
        };
    }

    resize(){
        if (this.x >= window.innerWidth){
            this.x = window.innerWidth - this.w;
        }
        if (this.y >= window.innerHeight){
            this.y = window.innerHeight - this.h;
        }
    }

    resizeEvent = (e) => {
        this.resize();
        this.style.transform = `translate(${this.x}px, ${this.y}px)`;
    }

    focus() {
        document.body.querySelectorAll("window-component").forEach((window) => {
            window.blur();
        });
        this.style.zIndex = "1001";
    }

    blur() {
       this.style.zIndex = "1000";
    }

    maximize() {
        this.moving = false;
        this.x = 0;
        this.y = 0;
        this.w = window.innerWidth;
        this.h = window.innerHeight;
        this.style.transform = `translate(${this.x}px, ${this.y}px)`;
        this.size = "maximized";
        this.render();
        this.focus();
    }

    minimize() {
        this.moving = false;
        this.h = 28;
        this.w = parseInt(localStorage.getItem(`${this.handle}-w`));
        this.size = "minimized";
        this.render();
        this.focus();
    }

    windowed() {
        this.moving = false;
        this.x = parseInt(localStorage.getItem(`${this.handle}-x`));
        this.y = parseInt(localStorage.getItem(`${this.handle}-y`));
        this.w = parseInt(localStorage.getItem(`${this.handle}-w`));
        this.h = parseInt(localStorage.getItem(`${this.handle}-h`));
        this.style.transform = `translate(${this.x}px, ${this.y}px)`;
        this.size = "normal";
        this.render();
        this.focus();
    }

    close(){
        this.remove();
    }

    save(){
        const bounds = this.getBoundingClientRect();
        this.x = bounds.x;
        this.y = bounds.y;
        this.w = bounds.width;
        if (this.w < this.minWidth){
            this.w = this.minWidth;
        }
        this.h = bounds.height;
        if (this.h < this.minHeight){
            this.h = this.minHeight;
        }
        if (this.size === "normal"){
            localStorage.setItem(`${this.handle}-w`, this.w.toFixed(0).toString());
            localStorage.setItem(`${this.handle}-h`, this.h.toFixed(0).toString());
        }
        if (this.size !== "maximized"){
            localStorage.setItem(`${this.handle}-x`, this.x.toFixed(0).toString());
            localStorage.setItem(`${this.handle}-y`, this.y.toFixed(0).toString());
        }
    }

    move = (e) => {
        if (this.moving){
            let x;
            let y;
            if (window.TouchEvent && e instanceof TouchEvent){
                x = e.touches[0].clientX;
                y = e.touches[0].clientY;
            } else {
                x = e.clientX;
                y = e.clientY;
            }
            const bounds = this.getBoundingClientRect();
            let diffX = bounds.x - x - this.localX;
            let diffY = bounds.y - y - this.localY;
            this.x -= diffX;
            this.y -= diffY;
            this.style.transform = `translate(${this.x}px, ${this.y}px)`;
        }
    }

    stopMove = (e) => {
        if (this.moving){
            this.save();
        }
        this.moving = false;
    }

    startMove = (e) => {
        if (this.size === "maximized"){
            return;
        }
        this.moving = true;
        let x;
        let y;
        if (window.TouchEvent && e instanceof TouchEvent){
            x = e.touches[0].clientX;
            y = e.touches[0].clientY;
        } else {
            x = e.clientX;
            y = e.clientY;
        }
        const bounds = this.getBoundingClientRect();
        this.localX = bounds.x - x;
        this.localY = bounds.y - y;
        this.focus();
    }

    handleMinimize = (e) => {
        this.minimize();
    }

    handleMaximize = (e) => {
        switch(this.size){
            case "normal":
                this.maximize();
                break;
            default:
                this.windowed();
                break;
        }
    }

    handleClose = (e) => {
        this.close();
    }

    noop = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
    }

    renderMaximizeIcon() {
        switch(this.size){
            case "normal":
                return html`
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-square" width="24" height="24" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <rect x="4" y="4" width="16" height="16" rx="2"></rect>
                    </svg>
                `;
            default:
                return html`
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-copy" width="24" height="24" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                        <rect x="8" y="8" width="12" height="12" rx="2"></rect>
                        <path d="M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2"></path>
                    </svg>
                `;
        }
    }

    renderContent() {
        let out;
        if (this.size !== "minimized"){
            out = html`
                <div class="container">
                    ${this.view}
                </div>
            `;
        } else {
            out = "";
        }
        return out;
    }

    renderControls() {
        if (this.enableControls){
            return html`
                <div class="h-full" flex="row nowrap items-center">
                    <button @click=${this.handleMinimize} @mousedown=${this.noop} sfx="button">
                        <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-minus" width="24" height="24" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </button>
                    <button @click=${this.handleMaximize} @mousedown=${this.noop} sfx="button">
                        ${this.renderMaximizeIcon()}
                    </button>
                    <button @click=${this.handleClose} @mousedown=${this.noop} sfx="button">
                        <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-x" width="24" height="24" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
            `;
        } else {
            return "";
        }
    }

    render() {
        this.style.width = `${this.w}px`;
        this.style.height = `${this.h}px`;
        this.setAttribute("window", this.handle);
        this.setAttribute("size", this.size);
        const view = html`
            <div class="header" flex="row nowrap items-center justify-between" @mousedown=${this.startMove} @touchstart=${this.startMove}>
                <h3 class="font-sm px-0.5">${this.name}</h3>
                ${this.renderControls()}
            </div>
            ${this.renderContent()}
            ${this.size === "minimized" ? "" : html`
                ${new ResizeHandle(this, "x", this.minWidth, this.minHeight)}
                ${new ResizeHandle(this, "y", this.minWidth, this.minHeight)}
                ${new ResizeHandle(this, "both", this.minWidth, this.minHeight)}
            `}
        `;
        render(view, this);
    }
}

class ResizeHandle extends HTMLElement {
    constructor(target, axis, minWidth = 411, minHeight = 231){
        super();
        this.resizing = false;
        this.pos1 = 0;
        this.pos2 = 0;
        this.pos3 = 0;
        this.pos4 = 0;
        this.target = target;
        this.axis = axis;
        this.minWidth = minWidth;
        this.minHeight = minHeight;
    }

    handleMouseDown = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.resizing = true;
        if (e instanceof MouseEvent){
            this.pos3 = e.clientX;
            this.pos4 = e.clientY;
        } else if (window.TouchEvent && e instanceof TouchEvent){
            this.pos3 = e.touches[0].clientX;
            this.pos4 = e.touches[0].clientY;
        }
    }

    handleMouseUp = () => {
        if (this.resizing){
            this.target?.save();
        }
        this.resizing = false;
    }

    handleMouseMove = (e) => {
        if (this.resizing){
            if (e instanceof MouseEvent){
                this.pos1 = this.pos3 - e.clientX;
                this.pos2 = this.pos4 - e.clientY;
                this.pos3 = e.clientX;
                this.pos4 = e.clientY;
            }else if (window.TouchEvent && e instanceof TouchEvent){
                this.pos1 = this.pos3 - e.touches[0].clientX;
                this.pos2 = this.pos4 - e.touches[0].clientY;
                this.pos3 = e.touches[0].clientX;
                this.pos4 = e.touches[0].clientY;
            }
            const bounds = this.target.getBoundingClientRect();
            let height = bounds.height - this.pos2;
            let width = bounds.width - this.pos1;
            if (height < this.minHeight){
                height = this.minHeight;
            } else if (height > window.innerHeight - 28){
                height = window.innerHeight - 28;
            }
            if (width < this.minWidth){
                width = this.minWidth;
            } else if (width > window.innerWidth){
                width = window.innerWidth;
            }
            switch (this.axis){
                case "x":
                    this.target.style.width = `${width}px`;
                    break;
                case "y":
                    this.target.style.height = `${height}px`;
                    break;
                default:
                    this.target.style.width = `${width}px`;
                    this.target.style.height = `${height}px`;
                    break;
            }
        }
    }

    connectedCallback() {
        window.addEventListener("mouseup", this.handleMouseUp, { capture: true, passive: true });
        window.addEventListener("mousemove", this.handleMouseMove, { capture: true, passive: true });
        window.addEventListener("touchend", this.handleMouseUp, { capture: true, passive: true });
        window.addEventListener("touchmove", this.handleMouseMove, { capture: true, passive: true });
        this.addEventListener("mousedown", this.handleMouseDown);
        this.addEventListener("touchstart", this.handleMouseDown);
    }
}

customElements.define("resize-handle", ResizeHandle);
customElements.define("window-component", WindowComponent);
customElements.define("file-size", FileSize);
customElements.define("level-button", LevelButton);
customElements.define("category-button", CategoryButton);
customElements.define("environment-button", EnvironmentButton);
customElements.define("message-search", MessageSearch);
customElements.define("table-component", TableComponent);
customElements.define("table-column-editor", TableColumnEditor);
