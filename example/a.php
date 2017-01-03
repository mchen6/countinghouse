<?php

// The data to send to the API
$postData = array(
    'serviceID' => 'urn:cdif-io:serviceID:短信服务',
    'actionName' => '发送验证码',
    'input' => array('phoneNum' => '13916381779', 'templateID' => '<模板ID>', 'content' => array('345756'))
);

$context = stream_context_create(array(
    'http' => array(
        'header' => "X-Apemesh-Key: <用户appKey>\r\n".
                    "Content-Type: application/json\r\n",
        'method' => 'POST',
        'content' => json_encode($postData)
    )
));

// Send the request
$response = file_get_contents('https://api.apemesh.com:3049/devices/f5dc73f9-b739-5ee2-add7-e499da04c6ec/invoke-action', FALSE, $context);

// Check for errors
if($response === FALSE){
    die('Error');
}

// Decode the response
$responseData = json_decode($response, TRUE);

// Print the date from the response
echo $responseData['output'];
?>
