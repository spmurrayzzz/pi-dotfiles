PI_HOME ?= $(HOME)/.pi

.PHONY: install test
install:
	@scripts/install.js "$(PI_HOME)"

test:
	@node --test
