import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyzeRepositories, RepoAnalysis } from './analyzer';
import * as packageJson from '../package.json';

export class RepoReportCardPanel {
    public static currentPanel: RepoReportCardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (RepoReportCardPanel.currentPanel) {
            RepoReportCardPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'repoReportCard',
            'Code Quality Report Card',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        RepoReportCardPanel.currentPanel = new RepoReportCardPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtmlContent();

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'analyze':
                        await this._handleAnalyze(message.urls);
                        break;
                    case 'savePdf':
                        await this._handleSavePdf(message.html);
                        break;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    private async _handleAnalyze(urls: string[]) {
        this._panel.webview.postMessage({ command: 'analysisStarted', count: urls.length });

        try {
            const results = await analyzeRepositories(urls, (current, total, currentUrl) => {
                this._panel.webview.postMessage({
                    command: 'analysisProgress',
                    current,
                    total,
                    currentUrl
                });
            });
            
            // Sort by score - include all results (errors shown separately)
            const ranking = results
                .sort((a, b) => {
                    // Put errors at the end
                    if (a.error && !b.error) return 1;
                    if (!a.error && b.error) return -1;
                    // Otherwise sort by score
                    return b.cleanlinessScore - a.cleanlinessScore;
                })
                .map(r => ({ repoName: r.repoName, cleanlinessScore: r.cleanlinessScore, hasError: !!r.error }));

            this._panel.webview.postMessage({
                command: 'analysisComplete',
                results: { analyses: results, ranking }
            });
        } catch (error: any) {
            this._panel.webview.postMessage({
                command: 'analysisError',
                error: error.message
            });
        }
    }

    private async _handleSavePdf(html: string) {
        try {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-report-card-'));
            const tmpFile = path.join(tmpDir, 'report.html');
            fs.writeFileSync(tmpFile, html, 'utf8');
            await vscode.env.openExternal(vscode.Uri.file(tmpFile));
            const printShortcut = process.platform === 'darwin' ? 'Cmd+P' : 'Ctrl+P';
            vscode.window.showInformationMessage(
                `Report opened in your browser. Use the Print dialog (${printShortcut}) and select "Save as PDF" to export.`
            );
            // Clean up the temp file after a delay to allow the browser to load it
            setTimeout(() => {
                try {
                    fs.unlinkSync(tmpFile);
                    fs.rmdirSync(tmpDir);
                } catch {
                    // Ignore cleanup errors
                }
            }, 60000);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to open report for PDF export: ${error.message}`);
        }
    }

    private _getHtmlContent(): string {
        // Read the local logo image and convert to base64 data URL
        let logoDataUrl = '';
        try {
            const logoFilePath = path.join(this._extensionUri.fsPath, 'media', 'logo.png');
            const logoBuffer = fs.readFileSync(logoFilePath);
            const logoBase64 = logoBuffer.toString('base64');
            logoDataUrl = `data:image/png;base64,${logoBase64}`;
        } catch (e) {
            // fallback to empty or placeholder
            logoDataUrl = '';
        }
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Repo Report Card</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Helvetica, Arial, sans-serif;
            min-height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }
        .container {
            max-width: 1000px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        .header {
            display: flex;
            align-items: center;
            margin-bottom: 40px;
            gap: 20px;
        }
        .logo {
            width: 120px;
            height: 120px;
            border-radius: 50%;
            object-fit: cover;
            border: 4px solid #667eea;
        }
        .title-container {
            flex: 1;
            text-align: center;
        }
        h1 {
            color: #333;
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        .subtitle {
            color: #666;
            font-size: 1.2em;
            font-style: italic;
        }
        .form-group {
            margin-bottom: 30px;
        }

        label {
            display: block;
            color: #333;
            font-weight: 600;
            margin-bottom: 10px;
            font-size: 1.1em;
        }

        textarea {
            width: 100%;
            padding: 15px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-family: monospace;
            font-size: 14px;
            resize: vertical;
            transition: border-color 0.3s;
        }

        textarea:focus {
            outline: none;
            border-color: #667eea;
        }

        button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 15px 40px;
            border-radius: 10px;
            font-size: 1.1em;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }

        button:active {
            transform: translateY(0);
        }

        button:disabled {
            background: #ccc;
            cursor: not-allowed;
            transform: none;
        }

        #loading {
            text-align: center;
            padding: 40px;
            color: #667eea;
            font-size: 1.2em;
        }

        #progressBar {
            margin-top: 20px;
            background: #f0f0f0;
            border-radius: 10px;
            padding: 20px;
            display: none;
        }

        .progress-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            font-weight: 600;
            color: #333;
        }

        .progress-track {
            background: #e0e0e0;
            height: 30px;
            border-radius: 15px;
            overflow: hidden;
            position: relative;
        }

        .progress-fill {
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
            height: 100%;
            border-radius: 15px;
            transition: width 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            min-width: 40px;
        }

        .progress-status {
            margin-top: 15px;
            padding: 15px;
            background: white;
            border-radius: 8px;
            border-left: 4px solid #667eea;
        }

        .progress-current {
            font-weight: 600;
            color: #667eea;
            margin-bottom: 5px;
        }

        .progress-next {
            color: #666;
            font-size: 0.9em;
        }

        #results {
            margin-top: 40px;
        }

        .ranking {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 20px;
            margin-bottom: 30px;
        }

        .ranking h2 {
            color: #333;
            margin-bottom: 15px;
        }

        .ranking-item {
            display: flex;
            align-items: center;
            padding: 10px;
            margin: 5px 0;
            background: white;
            border-radius: 8px;
        }

        .rank {
            font-size: 1.5em;
            font-weight: bold;
            margin-right: 15px;
            color: #667eea;
        }

        .repo-card {
            background: #f8f9fa;
            border-radius: 15px;
            padding: 30px;
            margin: 20px 0;
        }

        .repo-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        .repo-name {
            font-size: 1.8em;
            color: #333;
            font-weight: bold;
        }

        .grade {
            font-size: 3em;
            font-weight: bold;
            padding: 10px 30px;
            border-radius: 10px;
            background: white;
        }

        .grade-A { color: #4caf50; }
        .grade-B { color: #8bc34a; }
        .grade-C { color: #ffc107; }
        .grade-D { color: #ff9800; }
        .grade-F { color: #f44336; }
        .grade-ERROR { color: #9e9e9e; background: #f5f5f5; }

        .ranking-error {
            opacity: 0.7;
            background: #fafafa;
        }

        .assessment {
            background: white;
            border-left: 4px solid #667eea;
            padding: 20px;
            margin: 20px 0;
            border-radius: 8px;
        }

        .assessment-title {
            font-weight: bold;
            color: #667eea;
            margin-bottom: 10px;
        }

        .summary {
            color: #666;
            line-height: 1.6;
            margin-bottom: 15px;
            word-spacing: normal;
            letter-spacing: normal;
        }

        .improvement-list {
            list-style: none;
        }

        .improvement-item {
            background: white;
            padding: 15px;
            margin: 10px 0;
            border-radius: 8px;
            border-left: 4px solid #667eea;
            word-spacing: normal;
            letter-spacing: normal;
        }

        .improvement-category {
            font-weight: bold;
            color: #667eea;
            margin-bottom: 5px;
        }

        .improvement-priority {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.85em;
            font-weight: 600;
            margin-left: 10px;
        }

        .priority-High { background: #ffebee; color: #c62828; }
        .priority-Medium { background: #fff3e0; color: #f57c00; }
        .priority-Low { background: #e8f5e9; color: #2e7d32; }

        .error {
            background: #ffebee;
            color: #c62828;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }

        .button-group {
            display: flex;
            gap: 15px;
            margin-bottom: 20px;
        }

        #savePdfBtn {
            background: linear-gradient(135deg, #6c63ff 0%, #4834df 100%);
        }

        #savePdfBtn:hover {
            box-shadow: 0 5px 15px rgba(108, 99, 255, 0.4);
        }

        /* Print styles */
        @media print {
            body {
                background: white !important;
                padding: 0;
            }

            .container {
                box-shadow: none;
                padding: 20px;
            }

            .form-group, .button-group, #loading, #progressBar {
                display: none !important;
            }

            .repo-card {
                page-break-inside: avoid;
                break-inside: avoid;
                margin: 20px 0;
            }

            .ranking {
                page-break-after: auto;
                break-after: auto;
                margin-bottom: 30px;
            }
            
            .improvement-item {
                page-break-inside: avoid;
                break-inside: avoid;
            }
        }

        /* PDF export optimization */
        .pdf-export * {
            letter-spacing: 0 !important;
            word-spacing: 0 !important;
            text-rendering: geometricPrecision !important;
        }
        
        .pdf-export {
            background: white !important;
        }
        
        .pdf-export body {
            background: white !important;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <img src="${logoDataUrl}" alt="Principal Skinner" class="logo">
            <div class="title-container">
                <h1>📊 Code Quality Report Card</h1>
                <p class="subtitle">Analyze Repositories & Pull Requests | Powered by GitHub Copilot</p>
                <p class="version" style="font-size: 0.85em; color: #666; margin-top: 4px;">v${packageJson.version}</p>
            </div>
        </div>

        <div class="form-group">
            <label for="repoUrls">📚 Enter GitHub Repository or Pull Request URLs (one per line)</label>
            <textarea id="repoUrls" rows="8" placeholder="Repositories:
https://github.com/facebook/react
https://github.com/microsoft/vscode

Pull Requests:
https://github.com/owner/repo/pull/123
https://github.com/owner/repo/pull/456"></textarea>
        </div>

        <div class="button-group">
            <button id="analyzeBtn">🎓 Grade and Analyze</button>
            <button id="savePdfBtn" style="display: none;">📄 Save as PDF</button>
        </div>

        <div id="loading" style="display: none;">
            <p>📝 Principal Skinner is analyzing your code...</p>
        </div>

        <div id="progressBar" style="display: none;">
            <div class="progress-header">
                <span id="progressText">Processing repositories...</span>
                <span id="progressCount">0/0</span>
            </div>
            <div class="progress-track">
                <div class="progress-fill" id="progressFill" style="width: 0%">
                    <span id="progressPercent">0%</span>
                </div>
            </div>
            <div class="progress-status" id="progressStatus"></div>
        </div>

        <div id="results"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const analyzeBtn = document.getElementById('analyzeBtn');
        const savePdfBtn = document.getElementById('savePdfBtn');
        const repoUrlsInput = document.getElementById('repoUrls');
        const loading = document.getElementById('loading');
        const resultsDiv = document.getElementById('results');
        const progressBar = document.getElementById('progressBar');
        const progressFill = document.getElementById('progressFill');
        const progressPercent = document.getElementById('progressPercent');
        const progressCount = document.getElementById('progressCount');
        const progressStatus = document.getElementById('progressStatus');

        analyzeBtn.addEventListener('click', () => {
            const urls = repoUrlsInput.value
                .split('\\n')
                .map(url => url.trim())
                .filter(url => url.length > 0);

            if (urls.length === 0) {
                alert('Please enter at least one repository or pull request URL');
                return;
            }

            vscode.postMessage({ command: 'analyze', urls });
        });

        savePdfBtn.addEventListener('click', () => {
            const container = document.querySelector('.container');
            const styles = document.querySelector('style').innerHTML;

            const fullHtml = \`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Repo Report Card</title>
    <style>\${styles}</style>
</head>
<body>
    <div class="container">
        \${container.innerHTML}
    </div>
</body>
</html>\`;

            vscode.postMessage({ command: 'savePdf', html: fullHtml });
        });

        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.command) {
                case 'analysisStarted':
                    analyzeBtn.disabled = true;
                    loading.style.display = 'block';
                    progressBar.style.display = 'block';
                    resultsDiv.innerHTML = '';
                    savePdfBtn.style.display = 'none';
                    break;

                case 'analysisProgress':
                    const percent = Math.round((message.current / message.total) * 100);
                    progressFill.style.width = percent + '%';
                    progressPercent.textContent = percent + '%';
                    progressCount.textContent = \`\${message.current}/\${message.total}\`;
                    
                    // Show current repository being analyzed
                    const repoName = message.currentUrl.split('/').slice(-1)[0].replace(/\.git$/, '');
                    let statusHtml = \`<div class="progress-current">🔍 Currently analyzing: \${repoName}</div>\`;
                    
                    // Show next repository if there is one
                    if (message.current < message.total) {
                        statusHtml += \`<div class="progress-next">📋 Next up: Repository \${message.current + 1} of \${message.total}</div>\`;
                    } else {
                        statusHtml += \`<div class="progress-next">✨ Finalizing results...</div>\`;
                    }
                    
                    progressStatus.innerHTML = statusHtml;
                    loading.style.display = 'none';
                    break;

                case 'analysisComplete':
                    analyzeBtn.disabled = false;
                    loading.style.display = 'none';
                    progressBar.style.display = 'none';
                    savePdfBtn.style.display = 'block';
                    displayResults(message.results);
                    break;

                case 'analysisError':
                    analyzeBtn.disabled = false;
                    loading.style.display = 'none';
                    progressBar.style.display = 'none';
                    resultsDiv.innerHTML = \`<div class="error">❌ Error: \${message.error}</div>\`;
                    break;
            }
        });

        function getLetterGrade(score) {
            if (score >= 90) return 'A';
            if (score >= 80) return 'B';
            if (score >= 70) return 'C';
            if (score >= 60) return 'D';
            return 'F';
        }

        function getSkinnerQuote(score) {
            if (score >= 90) return '"An unforgettable performance!" - Excellent work.';
            if (score >= 80) return '"Adequate work, I suppose." - Good job.';
            if (score >= 70) return '"This is acceptable... barely." - Needs improvement.';
            if (score >= 60) return '"I\\'ve seen worse... not much worse." - Considerable work needed.';
            return '"This is an unfavorable review." - Pathetic.';
        }

        function displayResults(data) {
            let html = '';

            // Rankings
            if (data.ranking.length > 0) {
                html += '<div class="ranking"><h2>🏆 Rankings</h2>';
                data.ranking.forEach((item, index) => {
                    if (item.hasError) {
                        // Show error repos with special styling
                        html += \`
                            <div class="ranking-item ranking-error">
                                <span class="rank">#\${index + 1}</span>
                                <span style="flex: 1;">\${item.repoName}</span>
                                <span class="grade grade-ERROR" style="font-size: 1.5em; padding: 5px 15px;">ERROR</span>
                                <span style="margin-left: 15px; font-weight: bold; color: #999;">Technical Issue</span>
                            </div>
                        \`;
                    } else {
                        // Normal display for successfully analyzed repos
                        const grade = getLetterGrade(item.cleanlinessScore);
                        html += \`
                            <div class="ranking-item">
                                <span class="rank">#\${index + 1}</span>
                                <span style="flex: 1;">\${item.repoName}</span>
                                <span class="grade grade-\${grade}" style="font-size: 1.5em; padding: 5px 15px;">\${grade}</span>
                                <span style="margin-left: 15px; font-weight: bold;">\${item.cleanlinessScore}/100</span>
                            </div>
                        \`;
                    }
                });
                html += '</div>';
            }

            // Individual reports
            data.analyses.forEach(analysis => {
                const grade = getLetterGrade(analysis.cleanlinessScore);
                const quote = getSkinnerQuote(analysis.cleanlinessScore);

                html += \`<div class="repo-card">
                    <div class="repo-header">
                        <div>
                            <div class="repo-name">\${analysis.repoName}</div>
                            <a href="\${analysis.repoUrl}" target="_blank">\${analysis.repoUrl}</a>
                        </div>
                        <div class="grade grade-\${grade}">\${grade}</div>
                    </div>
                    <div style="text-align: center; font-size: 2em; margin: 20px 0;">Clean Code Score: \${analysis.cleanlinessScore}/100</div>
                    <div style="text-align: center; font-size: 2em; margin: 20px 0;">Overall Score: \${analysis.score}/100</div>
                \`;

                if (analysis.error) {
                    html += \`
                        <div class="error">
                            <div style="font-size: 1.3em; font-weight: bold; margin-bottom: 10px;">⚠️ Technical Error - Unable to Analyze</div>
                            <div style="margin-bottom: 10px;">This repository/PR could not be analyzed due to a technical issue, <strong>not</strong> because of code quality problems.</div>
                            <div style="background: white; padding: 15px; border-radius: 5px; margin-top: 10px;">
                                <strong>Error Details:</strong><br>
                                \${analysis.error}
                            </div>
                            <div style="margin-top: 15px; font-size: 0.9em; color: #666;">
                                <strong>Common causes:</strong>
                                <ul style="margin: 5px 0 0 20px;">
                                    <li>Repository is private or doesn't exist</li>
                                    <li>Network or authentication issues</li>
                                    <li>Invalid URL format</li>
                                    <li>Repository is empty or has no analyzable files</li>
                                </ul>
                            </div>
                        </div>
                    \`;
                } else {
                    html += \`
                        <div class="assessment">
                            <div class="assessment-title">Principal's Assessment: \${quote}</div>
                            <div class="summary">\${analysis.summary}</div>
                        </div>
                        <h3>📝 Areas Requiring Attention (5 Points):</h3>
                        <ul class="improvement-list">
                    \`;

                    analysis.improvementPlan.forEach((point, index) => {
                        html += \`
                            <li class="improvement-item">
                                <div class="improvement-category">
                                    \${index + 1}. \${point.category}
                                    <span class="improvement-priority priority-\${point.priority}">\${point.priority}</span>
                                </div>
                                <div>\${point.description}</div>
                            </li>
                        \`;
                    });

                    html += '</ul>';
                }

                html += '</div>';
            });

            resultsDiv.innerHTML = html;
        }
    </script>
</body>
</html>`;
    }

    public dispose() {
        RepoReportCardPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
