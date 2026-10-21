package main

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"strings"

	fzf "github.com/junegunn/fzf/src"
	"github.com/junegunn/fzf/src/protector"
)

var version = "0.74"
var revision = "devel"

//go:embed shell/key-bindings.bash
var bashKeyBindings []byte

//go:embed shell/completion.bash
var bashCompletion []byte

//go:embed shell/key-bindings.zsh
var zshKeyBindings []byte

//go:embed shell/completion.zsh
var zshCompletion []byte

//go:embed shell/key-bindings.fish
var fishKeyBindings []byte

//go:embed shell/key-bindings.nu
var nushellKeyBindings []byte

//go:embed shell/completion.nu
var nushellCompletion []byte

//go:embed shell/completion.fish
var fishCompletion []byte

//go:embed man/man1/fzf.1
var manPage []byte

func printScript(label string, content []byte) {
	fmt.Println("### " + label + " ###")
	fmt.Println(strings.TrimSpace(string(content)))
	fmt.Println("### end: " + label + " ###")
}

func exit(code int, err error) {
	if code == fzf.ExitError && err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
	}
	os.Exit(code)
}

func main() {
	protector.Protect()

	options, err := fzf.ParseOptions(true, os.Args[1:])
	if err != nil {
		exit(fzf.ExitError, err)
		return
	}
	if options.Bash {
		printScript("key-bindings.bash", bashKeyBindings)
		printScript("completion.bash", bashCompletion)
		return
	}
	if options.Zsh {
		printScript("key-bindings.zsh", zshKeyBindings)
		printScript("completion.zsh", zshCompletion)
		return
	}
	if options.Fish {
		printScript("key-bindings.fish", fishKeyBindings)
		printScript("completion.fish", fishCompletion)
		return
	}
	if options.Nushell {
		printScript("key-bindings.nu", nushellKeyBindings)
		printScript("completion.nu", nushellCompletion)
		return
	}
	if options.Help {
		fmt.Print(fzf.Usage)
		return
	}
	if options.Version {
		if len(revision) > 0 {
			fmt.Printf("%s (%s)\n", version, revision)
		} else {
			fmt.Println(version)
		}
		return
	}
	if options.Man {
		file := fzf.WriteTemporaryFile([]string{string(manPage)}, "\n")
		if len(file) == 0 {
			fmt.Print(string(manPage))
			return
		}
		defer os.Remove(file)
		candidates := [][]string{}
		if manPager := os.Getenv("MANPAGER"); len(manPager) > 0 {
			candidates = append(candidates, append(strings.Fields(manPager), file))
		}
		candidates = append(candidates, []string{"man", file})
		if pager := os.Getenv("PAGER"); len(pager) > 0 {
			candidates = append(candidates, append(strings.Fields(pager), file))
		}
		candidates = append(candidates, []string{"less", "-R", file}, []string{"more", file})
		for _, args := range candidates {
			if _, lookErr := exec.LookPath(args[0]); lookErr != nil {
				continue
			}
			cmd := exec.Command(args[0], args[1:]...)
			cmd.Stdin = os.Stdin
			cmd.Stdout = os.Stdout
			if err := cmd.Run(); err == nil {
				return
			}
		}
		fmt.Print(string(manPage))
		return
	}
	}

	code, err := fzf.Run(options)
	exit(code, err)
}
