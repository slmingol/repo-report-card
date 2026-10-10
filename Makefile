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
BUDGET     ?= 80000
OUT        ?= hackathon.html
REPO       ?=
REPOS_FILE ?= repos.txt
JOBS       ?= 1

_SINCE_ARG  = $(if $(SINCE),--since $(SINCE),)
_REPOS      = grep -v '^\s*\#\|^\s*$$' $(REPOS_FILE)

.DEFAULT_GOAL := help
.PHONY: help check score score-all render full open list clean clean-all

# ── Help ──────────────────────────────────────────────────────────────────────
help:
	@printf "\n$(B)$(MG)⚖  Principal Skinner$(R) — Hackathon Judging Pipeline\n"
	@printf "$(D)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(R)\n\n"
	@printf " $(B)Targets$(R)\n"
	@printf "  $(CY)make score$(R)       Score one repo    $(D)REPO=owner/repo [SINCE=YYYY-MM-DD]$(R)\n"
	@printf "  $(CY)make score-all$(R)   Score all repos   $(D)REPOS_FILE=$(REPOS_FILE) [SINCE=…] [JOBS=$(JOBS)]$(R)\n"
	@printf "  $(CY)make render$(R)      Stitch *-score.json  →  $(OUT)\n"
	@printf "  $(CY)make full$(R)        score-all + render (full pipeline)\n"
	@printf "  $(CY)make open$(R)        Open $(OUT) in browser\n"
	@printf "  $(CY)make list$(R)        List existing scorecard files\n"
	@printf "  $(CY)make clean$(R)       Remove *-score.json files\n"
	@printf "  $(CY)make clean-all$(R)   Remove score files + $(OUT)\n"
	@printf "  $(CY)make check$(R)       Verify required tools are installed\n"
	@printf "\n $(B)Variables$(R)\n"
	@printf "  $(YL)SINCE$(R)=$(D)YYYY-MM-DD$(R)      Hackathon start date (commit window filter)\n"
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
	@printf "\n$(CY)▶$(R) $(B)$(REPO)$(R)$(if $(SINCE),  $(D)since $(SINCE)$(R),)\n"
	@slug=$$(echo "$(REPO)" | sed 's|.*/||'); \
	outfile="$$slug-score.json"; \
	tmpfile=$$(mktemp); \
	sed -n '/## Technical Complexity Rubric/,$$p' README.md > "$$tmpfile"; \
	principal-skinner "$(REPO)" $(_SINCE_ARG) --budget $(BUDGET) \
	  | claude -p "$$(cat $$tmpfile)" --allowedTools '' 2>/dev/null > "$$outfile"; \
	rm -f "$$tmpfile"
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
	n=0; \
	_score() { \
	  repo="$$1"; rubric="$$2"; since_arg="$$3"; budget="$$4"; \
	  slug=$$(echo "$$repo" | sed 's|.*/||'); \
	  outfile="$$slug-score.json"; \
	  if [ -f "$$outfile" ]; then \
	    printf "$(D)skip$(R) $$repo  $(D)($$outfile exists)$(R)\n"; return; \
	  fi; \
	  printf "$(CY)▶$(R) $(B)$$repo$(R)\n"; \
	  principal-skinner "$$repo" $$since_arg --budget "$$budget" \
	    | claude -p "$$(cat $$rubric)" --allowedTools '' 2>/dev/null > "$$outfile" \
	    && printf "$(GR)✓$(R) $$repo\n" \
	    || printf "$(RD)✗$(R) $$repo $(RD)failed$(R)\n"; \
	}; \
	export -f _score; \
	$(_REPOS) | xargs -P $(JOBS) -I{} \
	  bash -c '_score "$$@"' _ "{}" "$$tmpfile" "$(_SINCE_ARG)" "$(BUDGET)"; \
	rm -f "$$tmpfile"; \
	done_count=$$(ls *-score.json 2>/dev/null | wc -l | tr -d ' '); \
	printf "\n$(GR)$(B)$$done_count/$$total$(R)$(GR) scorecards written$(R)\n\n"

# ── Render combined HTML ───────────────────────────────────────────────────────
render:
	@count=$$(ls *-score.json 2>/dev/null | wc -l | tr -d ' '); \
	[ "$$count" -gt 0 ] || (printf "$(RD)error:$(R) no *-score.json files — run make score-all first\n" && exit 1); \
	printf "\n$(CY)▶$(R) Stitching $(B)$$count$(R) score files  →  $(B)$(OUT)$(R)\n"; \
	skinner-render *-score.json > "$(OUT)"; \
	size=$$(du -sh "$(OUT)" | cut -f1); \
	printf "$(GR)✓$(R) $(B)$(OUT)$(R)  $(D)$$size$(R)\n\n"

# ── Full pipeline ──────────────────────────────────────────────────────────────
full: score-all render
	@printf "$(B)$(GR)Pipeline complete.$(R)  Run $(CY)make open$(R) to view.\n\n"

# ── Open in browser ────────────────────────────────────────────────────────────
open:
	@[ -f "$(OUT)" ] || (printf "$(RD)error:$(R) $(OUT) not found — run make render\n" && exit 1)
	@printf "$(CY)▶$(R) Opening $(B)$(OUT)$(R)\n"
	@open "$(OUT)" 2>/dev/null || xdg-open "$(OUT)" 2>/dev/null || \
	  printf "$(YL)!$(R) Cannot auto-open — open $(OUT) manually\n"

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
