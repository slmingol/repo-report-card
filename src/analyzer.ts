import * as vscode from 'vscode';
import { cloneRepository, cloneRepositoryWithPR, cleanupRepo, RepoInfo } from './git';

export interface ImprovementPoint {
    category: string;
    description: string;
    priority: 'High' | 'Medium' | 'Low';
}

export interface RepoAnalysis {
    repoName: string;
    repoUrl: string;
    score: number;
    cleanlinessScore: number;
    improvementPlan: ImprovementPoint[];
    summary: string;
    error?: string;
}

export async function analyzeRepositories(
    repoUrls: string[], 
    progressCallback?: (current: number, total: number, currentUrl: string) => void
): Promise<RepoAnalysis[]> {
    const results: RepoAnalysis[] = [];

    for (let i = 0; i < repoUrls.length; i++) {
        const url = repoUrls[i];
        
        // Report progress
        if (progressCallback) {
            progressCallback(i + 1, repoUrls.length, url);
        }
        
        try {
            // Check if this is a PR URL
            const isPRUrl = /github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/.test(url);
            
            const repoInfo = isPRUrl 
                ? await cloneRepositoryWithPR(url)
                : await cloneRepository(url);
                
            const analysis = await analyzeRepoWithCopilot(repoInfo);
            results.push(analysis);
            cleanupRepo(repoInfo.path);
        } catch (error: any) {
            results.push({
                repoName: url.split('/').pop() || 'unknown',
                repoUrl: url,
                score: 0,
                cleanlinessScore: 0,
                improvementPlan: [],
                summary: '',
                error: error.message
            });
        }
    }

    return results;
}

async function analyzeRepoWithCopilot(repoInfo: RepoInfo): Promise<RepoAnalysis> {
    try {
        // Check if we have files to analyze
        if (!repoInfo.files || repoInfo.files.length === 0) {
            throw new Error('No files available to analyze. The repository may be empty or contain only non-code files.');
        }
        
        // Try to get Claude Sonnet model first, fall back to GPT-4
        let models = await vscode.lm.selectChatModels({
            vendor: 'copilot',
            family: 'claude-sonnet'
        });

        let modelName = 'Claude Sonnet';
        
        // If Claude not available, try GPT-4
        if (models.length === 0) {
            models = await vscode.lm.selectChatModels({
                vendor: 'copilot',
                family: 'gpt-4o'
            });
            modelName = 'GPT-4o';
        }

        // If still no models, error out
        if (models.length === 0) {
            throw new Error('No AI models available. Make sure you have GitHub Copilot enabled.');
        }

        const model = models[0];
        console.log(`Using ${modelName} for repository analysis`);

        // Build the code context with indication of changed files for PRs
        const codeContext = repoInfo.files
            .map(f => {
                const changeIndicator = f.isChanged ? ' [CHANGED IN PR]' : '';
                return `File: ${f.path}${changeIndicator}\n\`\`\`\n${f.content}\n\`\`\``;
            })
            .join('\n\n');

        console.log(`Code context size: ${codeContext.length} characters from ${repoInfo.files.length} files`);

        // Adjust prompt based on whether this is a PR or full repo analysis
        const analysisType = repoInfo.isPR 
            ? `pull request #${repoInfo.prNumber} in the repository "${repoInfo.name.split(' (PR')[0]}"`
            : `repository "${repoInfo.name}"`;
        
        const focusGuidance = repoInfo.isPR
            ? 'Focus your analysis on the changed files (marked with [CHANGED IN PR]) and their impact on the overall codebase. Evaluate the quality of the changes, potential issues, and how well they integrate with existing code.'
            : 'Analyze the overall code quality, architecture, and maintainability of the repository.';

        const prompt = `You are a senior code reviewer analyzing the ${analysisType}.

Here is ${repoInfo.isPR ? 'the code with changes highlighted' : 'a sample of the repository\'s code'}:

${codeContext}

${focusGuidance}

Here is a list of the criteria for clean code:
1. Readability: The code is easy to read and comprehend. Variable, function, and class names are meaningful and self-explanatory; code is well-formatted and consistently styled.
2. Simplicity: The code solves problems in the simplest possible way without unnecessary complexity or clever tricks.
3. Consistency: The code follows a consistent style and conventions (naming, indentation, spacing, etc.) throughout the codebase.
4. Maintainability: Code is organized and modular, making it easy to modify, extend, or fix bugs without introducing new issues.
5. Documentation: The code is self-explanatory as much as possible, but essential comments and documentation are present where non-obvious logic occurs.
6. No Duplicates (DRY Principle): Repeated or duplicated code is avoided. Common functionality is extracted and reused.
7. Extensibility: The code can be extended with new functionality without extensive rewrites or breaking existing code.

Please analyze this ${repoInfo.isPR ? 'pull request' : 'repository'} and provide:
1. An overall quality score from 0-100
2. A clean code score from 0-100 based on the criteria for clean code given
3. A brief summary of the ${repoInfo.isPR ? 'changes\' strengths and weaknesses' : 'repository\'s strengths and weaknesses'}
4. Exactly 5 specific improvement points, each with:
   - category: A short category name
   - description: Detailed description of the improvement
   - priority: 'High', 'Medium', or 'Low'

IMPORTANT: You MUST respond with ONLY valid JSON. Do not include any explanatory text before or after the JSON.

Required JSON format:
{
  "score": <number 0-100>,
  "cleanlinessScore": <number 0-100>,
  "summary": "<your summary>",
  "improvementPlan": [
    {
      "category": "<category>",
      "description": "<description>",
      "priority": "<High|Medium|Low>"
    }
  ]
}

Return your response now as valid JSON:`;

        const messages = [
            vscode.LanguageModelChatMessage.User(prompt)
        ];

        const chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

        let fullResponse = '';
        for await (const fragment of chatResponse.text) {
            fullResponse += fragment;
        }

        // Check for empty response
        if (!fullResponse || fullResponse.trim().length === 0) {
            throw new Error('Copilot returned an empty response');
        }

        // Parse the JSON response - try multiple extraction methods
        let jsonText = '';
        
        // First try: extract from markdown code fence
        const markdownMatch = fullResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (markdownMatch) {
            jsonText = markdownMatch[1].trim();
        }
        
        // Second try: extract raw JSON from response (look for complete object)
        if (!jsonText) {
            // Try to find a complete JSON object by matching balanced braces
            const jsonStart = fullResponse.indexOf('{');
            if (jsonStart !== -1) {
                let braceCount = 0;
                let inString = false;
                let escapeNext = false;
                
                for (let i = jsonStart; i < fullResponse.length; i++) {
                    const char = fullResponse[i];
                    
                    if (escapeNext) {
                        escapeNext = false;
                        continue;
                    }
                    
                    if (char === '\\') {
                        escapeNext = true;
                        continue;
                    }
                    
                    if (char === '"') {
                        inString = !inString;
                        continue;
                    }
                    
                    if (!inString) {
                        if (char === '{') {
                            braceCount++;
                        } else if (char === '}') {
                            braceCount--;
                            if (braceCount === 0) {
                                jsonText = fullResponse.substring(jsonStart, i + 1);
                                break;
                            }
                        }
                    }
                }
            }
        }

        if (!jsonText) {
            console.error('Could not find JSON in response.');
            console.error('Response preview (first 500 chars):', fullResponse.substring(0, 500));
            console.error('Response preview (last 500 chars):', fullResponse.substring(Math.max(0, fullResponse.length - 500)));
            
            // Return a more detailed error with response preview
            const responsePreview = fullResponse.length > 200 
                ? fullResponse.substring(0, 200) + '...' 
                : fullResponse;
            throw new Error(`No JSON found in response. Copilot returned: "${responsePreview}"`);
        }

        let analysis;
        try {
            analysis = JSON.parse(jsonText);
        } catch (parseError: any) {
            console.error('JSON parse error:', parseError.message);
            console.error('Attempted to parse:', jsonText);
            throw new Error(`Failed to parse Copilot response - invalid JSON: ${parseError.message}`);
        }

        // Validate the response structure
        if (typeof analysis.score !== 'number') {
            throw new Error('Invalid response: missing or invalid "score" field');
        }
        if (typeof analysis.cleanlinessScore !== 'number') {
            throw new Error('Invalid response: missing or invalid "cleanlinessScore" field');
        }
        if (typeof analysis.summary !== 'string') {
            throw new Error('Invalid response: missing or invalid "summary" field');
        }
        if (!Array.isArray(analysis.improvementPlan)) {
            throw new Error('Invalid response: missing or invalid "improvementPlan" field');
        }

        return {
            repoName: repoInfo.name,
            repoUrl: repoInfo.url,
            score: analysis.score,
            cleanlinessScore: analysis.cleanlinessScore,
            summary: analysis.summary,
            improvementPlan: analysis.improvementPlan.slice(0, 10)
        };

    } catch (error: any) {
        return {
            repoName: repoInfo.name,
            repoUrl: repoInfo.url,
            score: 0,
            cleanlinessScore: 0,
            improvementPlan: [],
            summary: '',
            error: error.message
        };
    }
}
