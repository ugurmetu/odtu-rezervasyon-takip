import Foundation
import Security
import LocalAuthentication

let service = "tr.ugurmetu.rez-takip.credentials"
let account = "rez.metu.edu.tr"
let command = CommandLine.arguments.dropFirst().first ?? "status"
let context=LAContext()
context.interactionNotAllowed=true
let query: [String: Any] = [kSecClass as String:kSecClassGenericPassword,
    kSecAttrService as String:service, kSecAttrAccount as String:account,
    kSecUseAuthenticationContext as String:context]
func output(_ value:[String:Any]) {
    if let data=try? JSONSerialization.data(withJSONObject:value),let text=String(data:data,encoding:.utf8){print(text)}
}
func fail(_ status:OSStatus) -> Never { output(["ok":false,"error":status == errSecItemNotFound ? "credentials_missing" : "credentials_locked"]);exit(2) }
if command == "put" {
    let data=FileHandle.standardInput.readDataToEndOfFile()
    guard data.count < 4096,let object=(try? JSONSerialization.jsonObject(with:data)) as? [String:String],
      let user=object["username"], let password=object["password"],!user.isEmpty,!password.isEmpty else {exit(3)}
    let status=SecItemUpdate(query as CFDictionary,[kSecValueData as String:data] as CFDictionary)
    if status == errSecItemNotFound {
      var item=query;item[kSecValueData as String]=data;item.removeValue(forKey:kSecUseAuthenticationContext as String)
      let added=SecItemAdd(item as CFDictionary,nil);if added != errSecSuccess {fail(added)}
    } else if status != errSecSuccess {fail(status)}
    output(["ok":true]);exit(0)
}
if command == "get" {
    var request=query;request[kSecReturnData as String]=true;request[kSecMatchLimit as String]=kSecMatchLimitOne
    var result:CFTypeRef?;let status=SecItemCopyMatching(request as CFDictionary,&result)
    guard status == errSecSuccess,let data=result as? Data else {fail(status)}
    FileHandle.standardOutput.write(data);exit(0)
}
if command == "status" {
    var request=query;request[kSecReturnAttributes as String]=true
    var result:CFTypeRef?;let status=SecItemCopyMatching(request as CFDictionary,&result)
    output(["configured":status != errSecItemNotFound,"available":status == errSecSuccess]);exit(0)
}
exit(3)
