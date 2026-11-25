package expo.modules.kotlin.modules
class ModuleDefinitionData
class AppContext { val reactContext: android.content.Context? = null }
abstract class Module { val appContext = AppContext(); abstract fun definition(): ModuleDefinitionData }
class ModuleDefinitionBuilder {
  fun Name(n: String) {}
  fun OnCreate(body: () -> Unit) {}
  fun <R> Constant(name: String, body: () -> R) {}
  @JvmName("FunctionWithoutArgs") inline fun Function(name: String, crossinline body: () -> Any?) {}
  inline fun <reified R, reified P0> Function(name: String, crossinline body: (p0: P0) -> R) {}
}
inline fun Module.ModuleDefinition(crossinline block: ModuleDefinitionBuilder.() -> Unit): ModuleDefinitionData = ModuleDefinitionData()
