SHELL := /bin/bash

# ── ANSI ──────────────────────────────────────────────────────────────────────
B  := \033[1m
D  := \033[2m
R  := \033[0m
GR := \033[32m
CY := \033[36m
YL := \033[33m
MG := \033[35m
RD := \033[31m

# ── Config ────────────────────────────────────────────────────────────────────
SINCE      ?=
BUDGET     ?= 300000
TS         := $(shell date +%Y%m%d-%H%M%S)
RUNDIR     ?= runs/$(TS)
OUT        ?= $(RUNDIR)/hackathon.html
REPO       ?=
BRANCH     ?=
EVENT      ?=
REPOS_FILE ?= repos.txt
JOBS       ?= 1

_SINCE_ARG  = $(if $(SINCE),--since $(SINCE),)
_BRANCH_ARG = $(if $(BRANCH),--branch $(BRANCH),)
_EVENT_NOTE = $(if $(EVENT),\n\nThe event name is "$(EVENT)". Use this exact string for the `event` field in the JSON.,)
_REPOS      = grep -v '^\s*\#\|^\s*$$' $(REPOS_FILE)

.DEFAULT_GOAL := help
.PHONY: help check score score-all render full open list clean clean-all clean-runs screenshot

# ── Help ──────────────────────────────────────────────────────────────────────
help:
	@printf "\n$(B)$(MG)⚖  Principal Skinner$(R) — Hackathon Judging Pipeline\n"
	@printf "$(D)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(R)\n\n"
	@printf " $(B)Targets$(R)\n"
	@printf "  $(CY)make score$(R)       Score one repo    $(D)REPO=owner/repo [SINCE=YYYY-MM-DD] [BRANCH=name]$(R)\n"
	@printf "  $(CY)make score-all$(R)   Score all repos   $(D)REPOS_FILE=$(REPOS_FILE) [SINCE=…] [JOBS=$(JOBS)]$(R)\n"
	@printf "  $(CY)make render$(R)      Stitch *-score.json  →  $(OUT)\n"
	@printf "  $(CY)make full$(R)        score-all + render (full pipeline)\n"
	@printf "  $(CY)make open$(R)        Open $(OUT) in browser\n"
	@printf "  $(CY)make list$(R)        List existing scorecard files\n"
	@printf "  $(CY)make clean$(R)       Remove *-score.json files\n"
	@printf "  $(CY)make clean-all$(R)   Remove score files + $(OUT)\n"
	@printf "  $(CY)make check$(R)       Verify required tools are installed\n"
	@printf "  $(CY)make screenshot$(R)  Refresh README screenshots from demo data\n"
	@printf "\n $(B)Variables$(R)\n"
	@printf "  $(YL)SINCE$(R)=$(D)YYYY-MM-DD$(R)      Hackathon start date (commit window filter)\n"
	@printf "  $(YL)BRANCH$(R)=$(D)name$(R)           Clone specific branch (for branch-only repos)\n"
	@printf "  $(YL)BUDGET$(R)=$(D)$(BUDGET)$(R)         Max source chars sampled per repo\n"
	@printf "  $(YL)REPOS_FILE$(R)=$(D)$(REPOS_FILE)$(R)   Repo list file\n"
	@printf "  $(YL)JOBS$(R)=$(D)$(JOBS)$(R)              Parallel scoring jobs\n"
	@printf "  $(YL)OUT$(R)=$(D)$(OUT)$(R)    Combined output HTML\n"
	@printf "\n $(B)Examples$(R)\n"
	@printf "  $(D)make score     REPO=acme/hack SINCE=2026-10-08$(R)\n"
	@printf "  $(D)make score-all SINCE=2026-10-08 JOBS=4$(R)\n"
	@printf "  $(D)make full      SINCE=2026-10-08 OUT=results.html$(R)\n"
	@printf "  $(D)make render    OUT=final.html$(R)\n\n"

# ── Check tools ───────────────────────────────────────────────────────────────
check:
	@ok=1; \
	for tool in principal-skinner skinner-render claude gh git; do \
	  if command -v "$$tool" >/dev/null 2>&1; then \
	    printf "  $(GR)✓$(R)  $$tool\n"; \
	  else \
	    printf "  $(RD)✗$(R)  $$tool $(RD)(not found)$(R)\n"; ok=0; \
	  fi; \
	done; \
	[ "$$ok" -eq 1 ] || (printf "\n$(RD)Fix missing tools then retry.$(R)\n" && exit 1)

# ── Score one repo ─────────────────────────────────────────────────────────────
score: check
ifeq ($(strip $(REPO)),)
	@printf "$(RD)error:$(R) REPO is required\n"
	@printf "  usage: $(D)make score REPO=owner/repo [SINCE=YYYY-MM-DD]$(R)\n" && exit 1
endif
	@printf "\n$(CY)▶$(R) $(B)$(REPO)$(R)$(if $(BRANCH),@$(BRANCH),)$(if $(SINCE),  $(D)since $(SINCE)$(R),)\n"
	@slug=$$(echo "$(REPO)" | sed 's|.*/||'); \
	outfile="$$slug-score.json"; \
	tmpfile=$$(mktemp); \
	dossierfile=$$(mktemp); \
	sed -n '/## Technical Complexity Rubric/,$$p' README.md > "$$tmpfile"; \
	printf '%b' '$(_EVENT_NOTE)' >> "$$tmpfile"; \
	printf '\n\nOutput ONLY a raw JSON object matching the schema in your system prompt. No prose, no markdown, no code fences. Raw JSON only, starting with { and ending with }.' >> "$$tmpfile"; \
	principal-skinner "$(REPO)" $(_SINCE_ARG) $(_BRANCH_ARG) --budget $(BUDGET) > "$$dossierfile" 2>/dev/null; \
	tmpout=$$(mktemp); \
	claude -p "$$(cat $$tmpfile)" --allowedTools '' < "$$dossierfile" 2>/dev/null > "$$tmpout"; \
	rc=$$?; rm -f "$$tmpfile" "$$dossierfile"; \
	if [ $$rc -eq 0 ] && [ -s "$$tmpout" ]; then \
	  mv "$$tmpout" "$$outfile"; \
	else \
	  rm -f "$$tmpout"; \
	  printf "$(RD)error:$(R) claude produced no output for $(REPO)\n" >&2; exit 1; \
	fi
	@printf "$(GR)✓$(R) $(REPO) → $$(echo "$(REPO)" | sed 's|.*/||')-score.json\n\n"

# ── Score all repos from file ─────────────────────────────────────────────────
$(REPOS_FILE):
	@printf "$(RD)error:$(R) $(REPOS_FILE) not found\n"
	@printf "  Create it with one owner/repo per line.\n"
	@printf "  Lines starting with # are skipped.\n" && exit 1

score-all: check $(REPOS_FILE)
	@total=$$($(_REPOS) 2>/dev/null | wc -l | tr -d ' '); \
	printf "\n$(B)$(MG)Scoring $$total repos$(R)$(if $(SINCE),  $(D)since $(SINCE)$(R),)  jobs=$(B)$(JOBS)$(R)\n"; \
	printf "$(D)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(R)\n"; \
	tmpfile=$$(mktemp); \
	sed -n '/## Technical Complexity Rubric/,$$p' README.md > "$$tmpfile"; \
	printf '%b' '$(_EVENT_NOTE)' >> "$$tmpfile"; \
	printf '\n\nOutput ONLY a raw JSON object matching the schema in your system prompt. No prose, no markdown, no code fences. Raw JSON only, starting with { and ending with }.' >> "$$tmpfile"; \
	n=0; \
	_score() { \
	  repo="$$1"; rubric="$$2"; since_arg="$$3"; budget="$$4"; \
	  slug=$$(echo "$$repo" | sed 's|.*/||'); \
	  outfile="$$slug-score.json"; \
	  if [ -s "$$outfile" ]; then \
	    printf "$(D)skip$(R) $$repo  $(D)($$outfile exists)$(R)\n"; return; \
	  fi; \
	  rm -f "$$outfile"; \
	  printf "$(CY)▶$(R) $(B)$$repo$(R)\n"; \
	  dossierfile=$$(mktemp); tmpout=$$(mktemp); \
	  principal-skinner "$$repo" $$since_arg --budget "$$budget" > "$$dossierfile" 2>/dev/null; \
	  claude -p "$$(cat $$rubric)" --allowedTools '' < "$$dossierfile" 2>/dev/null > "$$tmpout"; \
	  rc=$$?; rm -f "$$dossierfile"; \
	  if [ $$rc -eq 0 ] && [ -s "$$tmpout" ]; then \
	    mv "$$tmpout" "$$outfile" && printf "$(GR)✓$(R) $$repo\n"; \
	  else \
	    rm -f "$$tmpout" && printf "$(RD)✗$(R) $$repo $(RD)failed$(R)\n"; \
	  fi; \
	}; \
	export -f _score; \
	$(_REPOS) | xargs -P $(JOBS) -I{} \
	  bash -c '_score "$$@"' _ "{}" "$$tmpfile" "$(_SINCE_ARG)" "$(BUDGET)"; \
	rm -f "$$tmpfile"; \
	done_count=$$(ls *-score.json 2>/dev/null | wc -l | tr -d ' '); \
	printf "\n$(GR)$(B)$$done_count/$$total$(R)$(GR) scorecards written$(R)\n\n"

# ── Render combined HTML ───────────────────────────────────────────────────────
render:
	@root_count=$$(ls *-score.json 2>/dev/null | wc -l | tr -d ' '); \
	if [ "$$root_count" -gt 0 ]; then \
	  prev=$$(ls -dt runs/*/ 2>/dev/null | head -1); \
	  if [ -n "$$prev" ]; then \
	    prev=$${prev%/}; \
	    new_count=0; \
	    for f in *-score.json; do \
	      [ -f "$$prev/$$f" ] || new_count=$$((new_count+1)); \
	    done; \
	    existing=$$(ls "$$prev"/*-score.json 2>/dev/null | wc -l | tr -d ' '); \
	    printf "$(D)merging $$root_count root score(s) with $$existing from $$prev$(R)\n"; \
	    cp "$$prev"/*-score.json . 2>/dev/null || true; \
	  fi; \
	  mkdir -p "$(RUNDIR)"; \
	  mv *-score.json "$(RUNDIR)/"; \
	  srcdir="$(RUNDIR)"; \
	else \
	  srcdir=$$(ls -dt runs/*/ 2>/dev/null | head -1); \
	  [ -n "$$srcdir" ] || (printf "$(RD)error:$(R) no score files in root or runs/ — run make score-all first\n" && exit 1); \
	  printf "$(D)no new scores in root — re-rendering from $$srcdir$(R)\n"; \
	fi; \
	count=$$(ls "$$srcdir"*-score.json 2>/dev/null | wc -l | tr -d ' '); \
	srcdir=$${srcdir%/}; \
	outfile="$$srcdir/hackathon-$(TS).html"; \
	printf "\n$(CY)▶$(R) Stitching $(B)$$count$(R) score files  →  $(B)$$outfile$(R)\n"; \
	skinner-render "$$srcdir"/*-score.json > "$$outfile"; \
	size=$$(du -sh "$$outfile" | cut -f1); \
	printf "$(GR)✓$(R) $(B)$$srcdir$(R)  [$$count score files + HTML  $(D)$$size$(R)]\n\n"

# ── Full pipeline ──────────────────────────────────────────────────────────────
full: score-all render
	@printf "$(B)$(GR)Pipeline complete.$(R)  Run $(CY)make open$(R) to view.\n\n"

# ── Open in browser ────────────────────────────────────────────────────────────
open:
	@latest=$$(ls -t runs/*/hackathon-*.html 2>/dev/null | head -1); \
	[ -n "$$latest" ] || (printf "$(RD)error:$(R) no rendered HTML found — run make render\n" && exit 1); \
	printf "$(CY)▶$(R) Opening $(B)$$latest$(R)\n"; \
	open "$$latest" 2>/dev/null || xdg-open "$$latest" 2>/dev/null || \
	  printf "$(YL)!$(R) Cannot auto-open — open $$latest manually\n"

# ── List scorecards ────────────────────────────────────────────────────────────
list:
	@count=$$(ls *-score.json 2>/dev/null | wc -l | tr -d ' '); \
	printf "\n$(B)Score files$(R)  ($(CY)$$count$(R) files)\n"; \
	printf "$(D)──────────────────────────────────────────────$(R)\n"; \
	ls -lhS *-score.json 2>/dev/null \
	  | awk '{printf "  \033[32m✓\033[0m  %-50s %s\n", $$9, $$5}' \
	  || printf "  $(D)none$(R)\n"; \
	printf "\n"

# ── Clean ──────────────────────────────────────────────────────────────────────
clean:
	@count=$$(ls *-score.json 2>/dev/null | wc -l | tr -d ' '); \
	[ "$$count" -gt 0 ] \
	  && (printf "$(YL)→$(R) Removing $(B)$$count$(R) score file(s)\n"; rm -f *-score.json) \
	  || printf "$(D)nothing to clean$(R)\n"

clean-all: clean
	@[ -f "$(OUT)" ] \
	  && (printf "$(YL)→$(R) Removing $(B)$(OUT)$(R)\n"; rm -f "$(OUT)") \
	  || true

clean-runs:
	@latest=$$(ls -dt runs/*/ 2>/dev/null | head -1); \
	[ -n "$$latest" ] || (printf "$(D)no runs/ to clean$(R)\n" && exit 0); \
	old=$$(ls -dt runs/*/ 2>/dev/null | tail -n +2); \
	[ -n "$$old" ] || (printf "$(D)only one run — nothing to remove$(R)\n" && exit 0); \
	count=$$(echo "$$old" | wc -l | tr -d ' '); \
	printf "$(YL)→$(R) Keeping $(B)$$latest$(R)\n"; \
	printf "$(YL)→$(R) Removing $(B)$$count$(R) older run(s)\n"; \
	echo "$$old" | xargs rm -rf

# ── Screenshots ────────────────────────────────────────────────────────────────
SHOT_PORT ?= 8742
screenshot:
	@command -v shot-scraper >/dev/null 2>&1 || (printf "$(RD)error:$(R) shot-scraper not found — pip install shot-scraper && playwright install chromium\n" && exit 1)
	@printf "\n$(CY)▶$(R) Rendering demo HTML\n"
	@skinner-render demo/*.json > /tmp/rrc-demo.html
	@sed 's/<html lang="en">/<html lang="en" data-theme="dark">/' /tmp/rrc-demo.html > /tmp/rrc-demo-dark.html
	@printf "$(CY)▶$(R) Starting server on port $(SHOT_PORT)\n"
	@lsof -ti :$(SHOT_PORT) | xargs kill -9 2>/dev/null; true
	@python3 -m http.server $(SHOT_PORT) --directory /tmp >/tmp/rrc-srv.log 2>&1 & SRV=$$!; \
	until curl -sf "http://localhost:$(SHOT_PORT)/rrc-demo.html" -o /dev/null; do sleep 0.3; done; \
	BASE="http://localhost:$(SHOT_PORT)/rrc-demo.html"; \
	BASED="http://localhost:$(SHOT_PORT)/rrc-demo-dark.html"; \
	OUT="media/screenshots"; \
	printf "$(CY)▶$(R) Capturing light mode\n"; \
	RESIZE_JS="var pt=document.documentElement.getAttribute('data-theme');document.querySelectorAll('.scorecard-frame').forEach(function(f){try{if(pt)f.contentDocument.documentElement.setAttribute('data-theme',pt);}catch(e){}var h=f.contentDocument&&f.contentDocument.body?f.contentDocument.body.scrollHeight:0;if(h>200)f.style.height=h+'px';});"; \
	shot-scraper "$$BASE" -o "$$OUT/01-detail-view.png"      --width 1440 --height 900 --javascript "$$RESIZE_JS" --timeout 2000 2>/dev/null; \
	shot-scraper "$$BASE" -o "$$OUT/02-overview-grid.png"    --width 1440 --height 900 --javascript "document.getElementById('overviewPanel').style.display='';document.getElementById('detailPanel').style.display='none';document.getElementById('btnOverview').classList.add('active');document.getElementById('btnDetail').classList.remove('active');" --timeout 2000 2>/dev/null; \
	shot-scraper "$$BASE" -o "$$OUT/03-overview-list.png"    --width 1440 --height 900 --javascript "document.getElementById('overviewPanel').style.display='';document.getElementById('detailPanel').style.display='none';document.getElementById('btnOverview').classList.add('active');document.getElementById('btnDetail').classList.remove('active');document.getElementById('overviewGrid').style.display='none';document.getElementById('overviewList').style.display='';document.getElementById('btnOvList').classList.add('active');document.getElementById('btnOvGrid').classList.remove('active');" --timeout 2000 2>/dev/null; \
	shot-scraper "$$BASE" -o "$$OUT/04-sidebar.png"          --width 1440 --height 900 --selector aside --timeout 2000 2>/dev/null; \
	shot-scraper "$$BASE" -o "$$OUT/05-detail-dims.png"      --width 1440 --height 900 --javascript "$$RESIZE_JS window.scrollTo(0,800);" --timeout 2000 2>/dev/null; \
	printf "$(CY)▶$(R) Capturing dark mode\n"; \
	shot-scraper "$$BASED" -o "$$OUT/01-detail-view-dark.png"   --width 1440 --height 900 --javascript "$$RESIZE_JS" --timeout 3000 2>/dev/null; \
	shot-scraper "$$BASED" -o "$$OUT/02-overview-grid-dark.png" --width 1440 --height 900 --javascript "document.getElementById('overviewPanel').style.display='';document.getElementById('detailPanel').style.display='none';document.getElementById('btnOverview').classList.add('active');document.getElementById('btnDetail').classList.remove('active');" --timeout 3000 2>/dev/null; \
	shot-scraper "$$BASED" -o "$$OUT/03-overview-list-dark.png" --width 1440 --height 900 --javascript "document.getElementById('overviewPanel').style.display='';document.getElementById('detailPanel').style.display='none';document.getElementById('btnOverview').classList.add('active');document.getElementById('btnDetail').classList.remove('active');document.getElementById('overviewGrid').style.display='none';document.getElementById('overviewList').style.display='';document.getElementById('btnOvList').classList.add('active');document.getElementById('btnOvGrid').classList.remove('active');" --timeout 3000 2>/dev/null; \
	shot-scraper "$$BASED" -o "$$OUT/04-sidebar-dark.png"       --width 1440 --height 900 --selector aside --timeout 3000 2>/dev/null; \
	shot-scraper "$$BASED" -o "$$OUT/05-detail-dims-dark.png"   --width 1440 --height 900 --javascript "$$RESIZE_JS window.scrollTo(0,800);" --timeout 3000 2>/dev/null; \
	kill $$SRV 2>/dev/null; \
	printf "$(GR)✓$(R) 10 screenshots written to $(B)$$OUT/$(R)\n\n"
