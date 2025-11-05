# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.


---------------------------------------------------------------------------------------------------------------------

LEFT TO DO:
- UI Improvements                                                             - DONE
- Function to swap out player on a court with someone sitting out easily
- Function to block / reduce available courts                                 - DONE
- Sound Check                                                                 - DONE
- Logic fix                                           - DONE (live testing required)
- Function to have 2 at least, but preferably multiple, separate player databases that can be switched between when in admin mode, to accommodate more clubs 
(or at least 2)                                                               -
- Small bug / UI fixes                                                  - (5/5) DONE
    - round # not increasing each time round ends                             - DONE
    - when admin mode is not enabled, 'Admin Controls' should be hidden from view on the Player List page                                                   - DONE
    - hide player skill level when admin mode is not enabled                                                                   - DONE
    - better name for 'Start Night' and/or 'Resume' considering how they function now                                                                       - DONE
    - when timer reaches 00:00 let the time blink red / white                                                                     - DONE
- Testing                                                    - ? WILL I EVER BE DONE

