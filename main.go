package main

import (
	"os"
	"os/signal"
	"syscall"

	"./safetyjim"
)

func main() {
	discord, err := safetyjim.New("something")
	if err != nil {
		os.Exit(-1)
	}

	sc := make(chan os.Signal, 1)
	signal.Notify(sc, syscall.SIGINT, syscall.SIGTERM, os.Interrupt, os.Kill)
	<-sc

	for i := 0; i < 2; i++ {
		discord.Sessions[i].Close()
	}
}
