export function addKey(key, email) {
    const apiURL = "https://v1.sphere.chat/add_key";
    var xhr = new XMLHttpRequest();
    xhr.open("POST", apiURL, false);
    xhr.setRequestHeader("Content-Type", "application/json");
    var data = JSON.stringify({ "license_key": `${key}`, "email": `${email}`});
    xhr.send(data);
    return (
        String(JSON.parse(xhr.responseText).status)
    );
}
