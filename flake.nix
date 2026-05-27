{
  description = "TallyBot — dev environment for the Tauri + SvelteKit desktop app";

  # Pinned to match this machine's registry (nixpkgs-unstable), so the binary
  # cache is shared and nothing is rebuilt from source.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      # Single target: this dev box is x86_64 NixOS. (Production runs on Windows
      # and doesn't use this flake; the firmware uses PlatformIO, also separate.)
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        nativeBuildInputs = with pkgs; [
          pkg-config
          wrapGAppsHook4 # wires GSettings schemas / GIO modules for the webview

          # Rust toolchain (Tauri's Rust shell)
          rustc
          cargo
          # Tauri CLI built BY NIX. We deliberately do NOT rely on the npm
          # @tauri-apps/cli: its prebuilt binary needs a real FHS loader, and
          # this box only has a stub nix-ld. Run `cargo tauri dev` / `cargo
          # tauri build` instead of `pnpm tauri ...`.
          cargo-tauri

          # Frontend toolchain (SvelteKit)
          nodejs_22
          pnpm
        ];

        buildInputs = with pkgs; [
          # Tauri 2 on Linux = webkit2gtk 4.1 (GTK3 + libsoup3). gtk3, libsoup,
          # glib, cairo, pango, etc. come in transitively via its pkg-config.
          webkitgtk_4_1
          librsvg
        ];

        # GSettings schemas must be on XDG_DATA_DIRS or the GTK webview aborts at
        # runtime. wrapGAppsHook4 exports $GSETTINGS_SCHEMAS_PATH; surface it.
        shellHook = ''
          export XDG_DATA_DIRS="$GSETTINGS_SCHEMAS_PATH:$XDG_DATA_DIRS"

          # WebKitGTK's DMA-BUF renderer crashes the Tauri window on NVIDIA +
          # Wayland with "Error 71 (Protocol error) dispatching to Wayland
          # display" — an unresolved upstream WebKit bug (CLAUDE.md has the
          # details: https://bugs.webkit.org/show_bug.cgi?id=280210). Disabling
          # that renderer is the reliable fix. Gate it to the affected setup so
          # accelerated rendering is untouched on X11 / non-NVIDIA GPUs, and let
          # an explicit override win.
          if [ -z "$WEBKIT_DISABLE_DMABUF_RENDERER" ] && [ -n "$WAYLAND_DISPLAY" ] && [ -d /sys/module/nvidia ]; then
            export WEBKIT_DISABLE_DMABUF_RENDERER=1
          fi
        '';
      };
    };
}
