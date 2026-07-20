package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

// assets embeds the built frontend so the production binary is self-contained.
// `wails build` populates frontend/dist via the Vite build step; `wails dev`
// instead serves from the running Vite dev server (configured in wails.json).
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "CotEditor",
		Width:     1024,
		Height:    720,
		MinWidth:  640,
		MinHeight: 480,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        app.startup,
		OnBeforeClose:    app.beforeClose,
		Bind: []interface{}{
			app,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
		},
		// SingleInstanceLock ensures only one CotEditor process runs at a time.
		// When a second instance is launched (e.g. the user double-clicks
		// another file while CotEditor is already open), Wails forwards its
		// command-line args to this callback and exits the second instance;
		// the running window then loads the requested file via an event.
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "coteditor-win-thepik-v1",
			OnSecondInstanceLaunch: func(data options.SecondInstanceData) {
				app.handleSecondInstance(data.Args)
			},
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
