import { Route, Switch } from 'wouter'
import { HomeScreen } from './screens/HomeScreen'
import { RoomScreen } from './screens/RoomScreen'

export function App() {
  return (
    <Switch>
      <Route path="/">
        <HomeScreen />
      </Route>
      <Route path="/join/:code">{(params) => <HomeScreen joinCode={params.code} />}</Route>
      <Route path="/room/:code">{(params) => <RoomScreen code={params.code.toUpperCase()} />}</Route>
      <Route>
        <HomeScreen />
      </Route>
    </Switch>
  )
}
